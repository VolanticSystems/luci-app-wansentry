// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 VolanticSystems

'use strict';
'require baseclass';
'require uci';

/*
 * wansentry, the mwan3 configuration generator.
 *
 * This module is the whole point of the package: it turns the nine fields on
 * the settings screen into the six mwan3 sections a pure 2-WAN failover setup
 * needs, and it does so through LuCI's uci API only. No file is ever written
 * by hand, no template is rendered into /etc/config/mwan3, and nothing here
 * runs a shell.
 *
 * Three rules govern everything below (docs/DESIGN.md §5):
 *
 *   1. wansentry owns a section if it carries `option wansentry '1'` or its
 *      name starts with `wansentry_`. It writes and deletes those freely.
 *   2. Sections identical to the ones the mwan3 package ships in its default
 *      /etc/config/mwan3 are package scaffolding, not configuration.
 *      wansentry adopts (deletes) them on first apply.
 *   3. Anything else is foreign. wansentry refuses to apply at all, it does
 *      not merge, reconcile or "fix" a configuration a human wrote.
 *
 * Rule 2 fails safe: if a future mwan3 release changes its shipped defaults,
 * those sections stop matching the fingerprint, get classified foreign, and
 * wansentry refuses instead of deleting something it does not understand.
 */

/* ------------------------------------------------------------ constants */

/* mwan3 truncates policy and rule names at 15 characters when it builds the
 * iptables chain names (mwan3.sh: `cut -c1-15`), and silently skips anything
 * longer. Hence `wansentry_fail` and `wansentry_def` rather than the more
 * readable full words. Member names have no such limit. */
var OWNER_OPT      = 'wansentry',
    MEMBER_PRIMARY = 'wansentry_primary',
    MEMBER_BACKUP  = 'wansentry_backup',
    POLICY         = 'wansentry_fail',
    RULE           = 'wansentry_def';

/* Exclusion rules generated from pbr's policies (see pbrClaims below). The
 * prefix is 13 characters, so two digits of index still fit inside mwan3's
 * 15-character name limit; PBR_MAX enforces that rather than trusting it. */
var PBR_PREFIX = 'wansentry_pbr',
    PBR_MAX    = 99;

var MANAGED_TYPES = [ 'interface', 'member', 'policy', 'rule' ];

/* The mwan3 package's shipped /etc/config/mwan3 (verified against
 * mwan3 2.12.0-r3 on OpenWrt 25.12.5). Section names alone are not enough to
 * identify scaffolding, a user configuring mwan3 through luci-app-mwan3 edits
 * exactly these sections, so every option value is part of the fingerprint. */
var V4_TRACK = [ '1.0.0.1', '1.1.1.1', '208.67.222.222', '208.67.220.220' ],
    V6_TRACK = [ '2606:4700:4700::1001', '2606:4700:4700::1111', '2620:0:ccd::2', '2620:0:ccc::2' ];

var STOCK = {
	'interface': {
		'wan':    { enabled: '1', track_ip: V4_TRACK, family: 'ipv4', reliability: '2' },
		'wan6':   { enabled: '0', track_ip: V6_TRACK, family: 'ipv6', reliability: '2' },
		'wanb':   { enabled: '0', track_ip: V4_TRACK, family: 'ipv4', reliability: '1' },
		'wanb6':  { enabled: '0', track_ip: V6_TRACK, family: 'ipv6', reliability: '1' }
	},
	'member': {
		'wan_m1_w3':   { interface: 'wan',   metric: '1', weight: '3' },
		'wan_m2_w3':   { interface: 'wan',   metric: '2', weight: '3' },
		'wanb_m1_w2':  { interface: 'wanb',  metric: '1', weight: '2' },
		'wanb_m1_w3':  { interface: 'wanb',  metric: '1', weight: '3' },
		'wanb_m2_w2':  { interface: 'wanb',  metric: '2', weight: '2' },
		'wan6_m1_w3':  { interface: 'wan6',  metric: '1', weight: '3' },
		'wan6_m2_w3':  { interface: 'wan6',  metric: '2', weight: '3' },
		'wanb6_m1_w2': { interface: 'wanb6', metric: '1', weight: '2' },
		'wanb6_m1_w3': { interface: 'wanb6', metric: '1', weight: '3' },
		'wanb6_m2_w2': { interface: 'wanb6', metric: '2', weight: '2' }
	},
	'policy': {
		'wan_only':  { use_member: [ 'wan_m1_w3', 'wan6_m1_w3' ] },
		'wanb_only': { use_member: [ 'wanb_m1_w2', 'wanb6_m1_w2' ] },
		'balanced':  { use_member: [ 'wan_m1_w3', 'wanb_m1_w3', 'wan6_m1_w3', 'wanb6_m1_w3' ] },
		'wan_wanb':  { use_member: [ 'wan_m1_w3', 'wanb_m2_w2', 'wan6_m1_w3', 'wanb6_m2_w2' ] },
		'wanb_wan':  { use_member: [ 'wan_m2_w3', 'wanb_m1_w2', 'wan6_m2_w3', 'wanb6_m1_w2' ] }
	},
	'rule': {
		'https':           { sticky: '1', dest_port: '443', proto: 'tcp', use_policy: 'balanced' },
		'default_rule_v4': { dest_ip: '0.0.0.0/0', use_policy: 'balanced', family: 'ipv4' },
		'default_rule_v6': { dest_ip: '::/0', use_policy: 'balanced', family: 'ipv6' }
	}
};

/* ------------------------------------------------------------- utilities */

function optKeys(obj) {
	return Object.keys(obj || {}).filter(function(k) { return k.charAt(0) !== '.'; }).sort();
}

function valueEq(a, b) {
	if (Array.isArray(a) || Array.isArray(b)) {
		var x = L.toArray(a), y = L.toArray(b);

		return x.length === y.length && x.every(function(v, i) { return String(v) === String(y[i]); });
	}

	if (a == null || b == null)
		return (a == null && b == null);

	return String(a) === String(b);
}

function sectionEq(sec, ref) {
	var have = optKeys(sec), want = optKeys(ref);

	if (have.length !== want.length || !have.every(function(k, i) { return k === want[i]; }))
		return false;

	return have.every(function(k) { return valueEq(sec[k], ref[k]); });
}

/* Clamp an integer to [min,max]. A value that is not a clean integer string
 * (a hand-edited /etc/config/wansentry could hold anything) falls back rather
 * than being silently coerced the way parseInt('5s') -> 5 would. */
function clamp(val, min, max, fallback) {
	var n = /^-?\d+$/.test(String(val ?? '').trim()) ? parseInt(val, 10) : fallback;

	return String(Math.min(max, Math.max(min, n)));
}

/* --------------------------------------------------------- settings read */

/* Normalise a raw {opt: value} map (clamping, derived timeout) into the settings
 * object the rest of the generator consumes. Kept separate from the uci read so
 * the LIVE form values can be normalised the same way for the on-screen preview,
 * before anything is saved. */
function normalize(raw) {
	var g = function(opt, def) {
		var v = raw[opt];

		return (v == null || v === '') ? def : v;
	};

	/* Floor of 2: the form's datatype is range(2,3600), so 1 could never be
	 * produced by the UI and must not slip in from a hand-edited config either.
	 * This floor is also what makes the derived timeout below strictly smaller
	 * than the interval for every possible input, which is the invariant mwan3
	 * needs and the reason validate() carries no timeout check. */
	var interval = clamp(g('interval', '5'), 2, 3600, 5);

	return {
		enabled:  g('enabled', '0') === '1',
		primary:  g('primary', ''),
		backup:   g('backup', ''),
		/* Trim and drop empties. L.toArray([ '' ]) has length 1, so an empty
		 * DynamicList row, or a `list track_ip ''` in a hand-edited config,
		 * used to satisfy validate()'s `!s.track_ip.length` check and then
		 * generate `list track_ip ''` into /etc/config/mwan3 -- an empty probe
		 * host that mwan3 can never reach. */
		track_ip: L.toArray(raw.track_ip)
		            .map(function(v) { return String(v == null ? '' : v).trim(); })
		            .filter(function(v) { return v.length > 0; }),
		interval: interval,
		down:     clamp(g('down', '3'), 1, 100, 3),
		up:       clamp(g('up', '6'), 1, 100, 6),
		/* mwan3 needs the per-probe timeout to be shorter than the check
		 * interval, otherwise a slow probe and the next check overlap. */
		timeout:  clamp(Math.min(4, parseInt(interval, 10) - 1), 1, 10, 2),
		failback: g('failback', '1') === '1',
		flush:    g('flush_conntrack', '1') === '1'
	};
}

/* Reads /etc/config/wansentry through uci (loaded or pending values). */
function settings() {
	return normalize({
		enabled:         uci.get('wansentry', 'main', 'enabled'),
		primary:         uci.get('wansentry', 'main', 'primary'),
		backup:          uci.get('wansentry', 'main', 'backup'),
		track_ip:        uci.get('wansentry', 'main', 'track_ip'),
		interval:        uci.get('wansentry', 'main', 'interval'),
		down:            uci.get('wansentry', 'main', 'down'),
		up:              uci.get('wansentry', 'main', 'up'),
		failback:        uci.get('wansentry', 'main', 'failback'),
		flush_conntrack: uci.get('wansentry', 'main', 'flush_conntrack')
	});
}

/* ------------------------------------------------------- pbr coexistence */

/*
 * pbr (the Policy Based Routing package) claims traffic by source and
 * destination and steers it to an interface of its own choosing, most often a
 * VPN tunnel. Both pbr and mwan3 mark packets and both install `ip rule`
 * entries, and the naive worry is that their fwmarks collide. They do not:
 *
 *     pbr    masks on 0x00ff0000,  ip rules at priority 29995-30000
 *     mwan3  masks on 0x00003f00,  ip rules at priority  1001-3002
 *
 * The bit ranges are disjoint, so both marks sit on the same packet without
 * either corrupting the other. The problem is the PRIORITIES. Rule evaluation
 * runs in ascending order, so mwan3's table is consulted roughly 28,000
 * priorities before pbr's, and pbr's decision never runs.
 *
 * Measured on the bench 2026-08-27, with real forwarded traffic and the
 * conntrack reply tuple naming the uplink that performed the SNAT:
 *
 *     without an exclusion  client in a pbr policy range -> plain WAN
 *     with an exclusion     same client                  -> the tunnel
 *
 * Neither package logs anything either way. Traffic keeps flowing and simply
 * stops going where the operator sent it, which is why this has to be handled
 * rather than documented.
 *
 * The fix is to keep mwan3's hands off traffic pbr has already claimed: an
 * mwan3 rule carrying `use_policy 'default'`, ordered ahead of the catch-all,
 * stamps mwan3's no-op mark 0x3f00. That mark matches none of mwan3's own ip
 * rules, so evaluation falls through to pbr's and the policy survives.
 *
 * This is a seam, not a workaround. pbr decides which traffic enters the
 * tunnel; mwan3 decides which uplink the tunnel's own packets ride on. The
 * tunnel's outer packets are router-originated and therefore outside any
 * sensible pbr source range, which is exactly why they still fail over.
 */

/* pbr accepts several addresses in one option, space or comma separated. mwan3
 * rules take a single address each, so one pbr policy can yield several
 * exclusions. */
function splitAddrs(v) {
	return String(v == null ? '' : v).split(/[\s,]+/).filter(function(x) { return x.length > 0; });
}

/* Read pbr's policies and reduce them to the match criteria an mwan3 rule can
 * express. Returns { claims: [...], skipped: [...] }.
 *
 * A policy is SKIPPED, never silently approximated, when it carries neither a
 * source nor a destination address. Such a policy claims everything, and an
 * mwan3 rule mirroring it would match every packet on the router, including
 * the tunnel's own outer packets, and disable failover entirely while
 * appearing to configure it. Refusing and reporting is the only safe answer.
 */
function pbrClaims() {
	var claims = [], skipped = [];

	/* pbr absent, or its config unreadable, means nothing to exclude. This is
	 * the common case and must cost nothing. */
	if (!uci.sections('pbr', 'pbr').length && !uci.sections('pbr', 'policy').length)
		return { claims: claims, skipped: skipped };

	var globals = uci.sections('pbr', 'pbr')[0];

	/* pbr installed but switched off installs no rules, so nothing can be
	 * overridden and an exclusion would only add noise. */
	if (globals && globals.enabled === '0')
		return { claims: claims, skipped: skipped };

	uci.sections('pbr', 'policy').forEach(function(p) {
		if (p.enabled === '0')
			return;

		var src = splitAddrs(p.src_addr),
		    dst = splitAddrs(p.dest_addr),
		    name = p.name || p['.name'];

		if (!src.length && !dst.length) {
			skipped.push(name);

			return;
		}

		/* mwan3 rejects a port match without a protocol, and pbr allows one.
		 * Carry ports only when a protocol makes them expressible. */
		var proto = (p.proto || '').toLowerCase(),
		    ports = (proto === 'tcp' || proto === 'udp');

		/* Cross-product, because each mwan3 rule holds one address per side. */
		(src.length ? src : [ null ]).forEach(function(s) {
			(dst.length ? dst : [ null ]).forEach(function(d) {
				var c = { policy: name };

				if (s != null) c.src_ip  = s;
				if (d != null) c.dest_ip = d;

				if (proto && proto !== 'all')
					c.proto = proto;

				if (ports && p.src_port)  c.src_port  = String(p.src_port);
				if (ports && p.dest_port) c.dest_port = String(p.dest_port);

				claims.push(c);
			});
		});
	});

	/* Deterministic order, so the same pbr config always produces the same
	 * mwan3 file and a re-apply stays a no-op. uci section order is stable but
	 * the cross-product above is not something a reader can predict, and an
	 * unstable order would churn the config on every apply. */
	claims.sort(function(a, b) {
		var ka = [ a.src_ip, a.dest_ip, a.proto, a.src_port, a.dest_port ].join('|'),
		    kb = [ b.src_ip, b.dest_ip, b.proto, b.src_port, b.dest_port ].join('|');

		return (ka < kb) ? -1 : (ka > kb ? 1 : 0);
	});

	if (claims.length > PBR_MAX)
		claims = claims.slice(0, PBR_MAX);

	return { claims: claims, skipped: skipped };
}

/* The mwan3 rule sections that keep pbr's policies working. */
function pbrRules() {
	return pbrClaims().claims.map(function(c, i) {
		var o = { family: 'ipv4' };

		if (c.src_ip)    o.src_ip    = c.src_ip;
		if (c.dest_ip)   o.dest_ip   = c.dest_ip;
		if (c.proto)     o.proto     = c.proto;
		if (c.src_port)  o.src_port  = c.src_port;
		if (c.dest_port) o.dest_port = c.dest_port;

		/* 'default' is mwan3's own escape hatch: route by the main table and
		 * stamp only the no-op mark. It is not a policy wansentry defines, so
		 * it cannot drift when the failover policy is rewritten. */
		o.use_policy = 'default';
		o[OWNER_OPT] = '1';

		return { name: PBR_PREFIX + (i + 1), type: 'rule', options: o };
	});
}

/* ------------------------------------------------ interface classification */

/*
 * Which interfaces may be offered as an uplink, and why the others may not.
 *
 * Classify by EVIDENCE, never by name. The instinct to refuse name-guessing is
 * right: an LTE stick, a tethered phone and a neighbour's wifi joined as a
 * station are all legitimate backups and none of them is called "wan". But
 * refusing to guess by name does not mean offering everything; it means
 * deciding on what the interface actually is.
 *
 * Four roles, from protocol, device and gateway:
 *
 *   uplink   up, and has a gateway of its own. Offered.
 *   tunnel   a tunnel protocol, or a tun/tap/wg device. Rides ON an uplink, so
 *            failing over TO one is meaningless: if the uplink beneath it is
 *            down, so is the tunnel.
 *   local    up with no gateway, or a bridge that is down. LAN, guest, DMZ.
 *   unknown  down and not obviously a bridge, so we genuinely cannot tell.
 *            OFFERED DELIBERATELY: this is the LTE stick that is not plugged
 *            in, and hiding it would turn the classifier's mistakes into the
 *            user's dead end.
 *
 * Nothing is hidden. Ineligible interfaces are still listed, with the reason
 * attached, behind a toggle.
 */

var TUNNEL_PROTOS = [ 'wireguard', 'openvpn', 'ovpn', 'gre', 'gretap',
                      'grev6', 'vti', 'vtiv6', 'xfrm', 'l2tp', 'vxlan',
                      'zerotier', 'tailscale', 'sstp', 'softethervpn' ];

/* netifd first, uci second.
 *
 * LuCI's Network object reads the protocol and the device from
 * /etc/config/network, and this package deliberately does NOT grant uci read on
 * that file: it holds PPPoE passwords and WireGuard private keys. So on a
 * properly restricted session getProtocol() and getDevice() return nothing.
 *
 * _ubus() reads netifd's own dump, which LuCI has already fetched for other
 * reasons and which the ACL does grant. It is how LuCI's own isUp() works, and
 * isUp() kept working on a restricted session while getProtocol() did not,
 * which is exactly the clue. Using it costs no extra RPC call.
 *
 * Guarded with typeof so that if a future LuCI drops the method this falls back
 * to the uci path instead of throwing.
 */
function ifProto(n) {
	var v = (n && typeof n._ubus === 'function') ? n._ubus('proto') : null;

	return String(v || (n && n.getProtocol && n.getProtocol()) || '');
}

function ifDevice(n) {
	var v = (n && typeof n._ubus === 'function')
	        ? (n._ubus('device') || n._ubus('l3_device')) : null;

	if (v)
		return String(v);

	var dev = (n && n.getDevice) ? n.getDevice() : null;

	return dev ? String(dev.getName()) : '';
}

function roleOf(n) {
	var proto = ifProto(n),
	    devname = ifDevice(n);

	if (TUNNEL_PROTOS.indexOf(proto) >= 0)
		return 'tunnel';

	/* A tun/tap/wg device is a tunnel whatever the interface protocol claims.
	 * OpenVPN on OpenWrt is commonly wired up as `proto none` over tun0, which
	 * no protocol test would ever catch, and that is how the reference
	 * production router is configured. */
	if (/^(tun|tap|wg)[0-9-]/.test(devname))
		return 'tunnel';

	/* A gateway is the evidence that decides the rest, and it is only
	 * trustworthy while the interface is up: an uplink that is merely down has
	 * no gateway either, and calling that "local" would hide the user's backup
	 * at the moment they came to configure it. */
	if (n.isUp && n.isUp())
		return (n.getGatewayAddr && n.getGatewayAddr()) ? 'uplink' : 'local';

	if (/^br-/.test(devname))
		return 'local';

	return 'unknown';
}

/* Classify every interface and work out what the settings screen may offer.
 *
 * networks  LuCI Network objects (or anything with the same four accessors)
 * chosen    [primary, backup] as currently saved, so a stored selection can
 *           never become unselectable
 * showAll   the user's toggle
 *
 * Returns { all, eligible, forceAll, choices }.
 */
function classify(networks, chosen, showAll) {
	var NOTE = {
		uplink:  null,
		tunnel:  _('VPN tunnel: runs over an uplink, cannot be one'),
		local:   _('local network: no gateway of its own'),
		unknown: _('never seen up: cannot tell')
	};

	var picked = L.toArray(chosen).filter(function(x) { return x != null && x !== ''; });

	var all = L.toArray(networks).filter(function(n) {
		/* An IIPv6-only interface cannot carry the IPv4 policy this package
		 * generates, so offering it would only produce an uplink that never
		 * comes up.
		 *
		 * This used to read `n.getProtocol() !== 'dhcpv6'`, which is TRUE when
		 * the protocol is merely unavailable, so on a restricted session every
		 * IPv6-only interface was offered as a candidate uplink. ifProto()
		 * consults netifd, so the protocol is known even then. */
		return n && n.getName && n.getName() !== 'loopback' && ifProto(n) !== 'dhcpv6';
	}).map(function(n) {
		var role = roleOf(n);

		/* "wan (eth1)" tells a user nothing. Protocol, device and state are
		 * what let someone with six interfaces pick the right one. Empty parts
		 * are dropped rather than joined anyway, so a label never renders a
		 * dangling comma because one input was unavailable. */
		var bits = [ ifProto(n), ifDevice(n), (n.isUp && n.isUp()) ? _('up') : _('down') ]
		           .filter(function(b) { return b != null && String(b).length > 0; });

		var label = '%s: %s'.format(n.getName(), bits.join(', '));

		return {
			name: n.getName(),
			role: role,
			label: NOTE[role] ? '%s [%s]'.format(label, NOTE[role]) : label
		};
	});

	var eligible = all.filter(function(c) {
		return c.role === 'uplink' || c.role === 'unknown';
	});

	/* Show everything when the classifier has left too little to pick from, or
	 * when a saved selection is one it would not offer. Narrowing the list out
	 * from under a stored value would blank it on the next save. */
	var forceAll = eligible.length < 2 || all.some(function(c) {
		return picked.indexOf(c.name) >= 0 && c.role !== 'uplink' && c.role !== 'unknown';
	});

	var list = (forceAll || showAll) ? all : eligible;

	return {
		all: all,
		eligible: eligible,
		forceAll: forceAll,
		choices: list.map(function(c) { return [ c.name, c.label ]; })
	};
}

/* --------------------------------------------------- desired mwan3 model */

function trackOptions(s) {
	var o = {
		enabled:           s.enabled ? '1' : '0',
		family:            'ipv4',
		/* DELIBERATELY NOT mwan3's own default of 'online'. Measured on the
		 * bench 2026-08-28, and it is the commonest real outage that exposes it.
		 *
		 * Pull a cable and the link and the internet behind it return at the
		 * same instant, so 'online' looks fine. Power-cycle a modem and they do
		 * not: ethernet carrier comes back in a second or two, the service
		 * behind it takes another twenty to sixty. 'online' tells mwan3 to
		 * assume a returning interface is good, so it moves traffic back to an
		 * uplink that cannot carry it, and the LAN gets a SECOND outage lasting
		 * until the probes fail again (down x interval).
		 *
		 *   initial_state online   link back, internet dead
		 *                          -> act=wan while wan is disconnecting
		 *                          -> client BROKEN for ~9 s
		 *   initial_state offline  same conditions
		 *                          -> stays on the backup, wan goes offline
		 *                          -> client never loses routing
		 *
		 * The obvious objection is a slow start after a reboot, and it does not
		 * happen: the generated policy carries `last_resort default`, so until
		 * an uplink has proved itself traffic falls through to the main routing
		 * table, which uses the lowest-metric default route. Measured across an
		 * mwan3 restart, the client stayed reachable throughout apart from the
		 * one second the restart itself costs, which is identical either way.
		 *
		 * A residual blip on link restore remains and is NOT this setting: it is
		 * `flush_conntrack ifup` clearing the table globally, which the settings
		 * screen already names as the cost of flushing at all. */
		initial_state:     'offline',
		track_method:      'ping',
		track_ip:          s.track_ip.slice(),
		/* Any single host answering keeps the uplink up. Some upstreams rate
		 * limit or drop ICMP outright, and a two-host check that demands both
		 * turns that into a phantom outage (prior-art audit, sharp edge 7). */
		reliability:       '1',
		count:             '1',
		timeout:           s.timeout,
		interval:          s.interval,
		failure_interval:  s.interval,
		recovery_interval: s.interval,
		down:              s.down,
		up:                s.up
	};

	o[OWNER_OPT] = '1';

	/* mwan3's flush_conntrack is a list of hotplug actions, not a boolean.
	 * All four are needed for symmetric behaviour: ifdown/disconnected covers
	 * the failover, ifup/connected covers the failback. */
	if (s.flush)
		o.flush_conntrack = [ 'ifdown', 'disconnected', 'ifup', 'connected' ];

	return o;
}

function desired(s) {
	var rule = {
		dest_ip:    '0.0.0.0/0',
		family:     'ipv4',
		use_policy: POLICY,
		/* Stickiness is the only lever mwan3 gives us over failback. It is an
		 * ipset keyed on source IP with a timeout: a client that failed over
		 * keeps using the backup for up to `timeout` seconds after its last
		 * matching packet, while other clients follow the policy back to the
		 * primary immediately. Source-IP based, not per-connection. See
		 * docs/DESIGN.md §7.4. */
		sticky:     s.failback ? '0' : '1'
	};

	if (!s.failback)
		rule.timeout = '600';

	rule[OWNER_OPT] = '1';

	var member = function(iface, metric) {
		var m = { interface: iface, metric: metric, weight: '1' };

		m[OWNER_OPT] = '1';

		return m;
	};

	var policy = {
		use_member: [ MEMBER_PRIMARY, MEMBER_BACKUP ],
		/* If both uplinks are marked offline, fall through to the kernel
		 * routing table instead of blackholing. A tracking false positive
		 * then degrades to plain routing rather than a total outage. */
		last_resort: 'default'
	};

	policy[OWNER_OPT] = '1';

	/* Rule ORDER is load-bearing: mwan3 evaluates rules in file order and stops
	 * at the first match, so every pbr exclusion must precede the catch-all or
	 * it can never fire. write() enforces this position after the fact, because
	 * uci.add always appends and a rule added on a later apply would otherwise
	 * land behind the catch-all and silently do nothing. */
	return [
		{ name: s.primary, type: 'interface', options: trackOptions(s) },
		{ name: s.backup,  type: 'interface', options: trackOptions(s) },
		{ name: MEMBER_PRIMARY, type: 'member', options: member(s.primary, '1') },
		{ name: MEMBER_BACKUP,  type: 'member', options: member(s.backup,  '2') },
		{ name: POLICY, type: 'policy', options: policy }
	].concat(pbrRules(), [
		{ name: RULE, type: 'rule', options: rule }
	]);
}

/* ------------------------------------------------------------- ownership */

function isOwned(sec) {
	return sec[OWNER_OPT] === '1' || /^wansentry_/.test(sec['.name'] || '');
}

function isStock(sec) {
	var ref = (STOCK[sec['.type']] || {})[sec['.name']];

	return (ref != null && sectionEq(sec, ref));
}

/* Classifies every section in /etc/config/mwan3. `globals` is mwan3's own
 * infrastructure (the firewall mark mask): wansentry neither owns it nor
 * treats it as foreign, it only creates it if it is missing entirely. */
function audit() {
	var owned = [], stock = [], foreign = [];

	uci.sections('mwan3').forEach(function(sec) {
		var type = sec['.type'], name = sec['.name'];

		if (type === 'globals')
			return;

		if (MANAGED_TYPES.indexOf(type) < 0)
			foreign.push({ name: name, type: type });
		else if (isOwned(sec))
			owned.push({ name: name, type: type });
		else if (isStock(sec))
			stock.push({ name: name, type: type });
		else
			foreign.push({ name: name, type: type });
	});

	return { owned: owned, stock: stock, foreign: foreign };
}

/* ----------------------------------------------------------------- apply */

/* mwan3 (and rpcd's uci name check) accept only [A-Za-z0-9_] in a section name;
 * wansentry additionally reserves its own wansentry_* namespace so a chosen
 * interface can never collide with a generated member/policy/rule name. */
var RESERVED = { 'wansentry_primary': 1, 'wansentry_backup': 1,
                 'wansentry_fail': 1, 'wansentry_def': 1 };

function validName(name) {
	return /^[A-Za-z0-9_]+$/.test(name) && !/^wansentry_/.test(name) && !RESERVED[name];
}

function validate(s) {
	if (!s.primary || !s.backup)
		return _('Select a primary and a backup interface first.');

	if (s.primary === s.backup)
		return _('The primary and the backup interface must be different.');

	if (!validName(s.primary) || !validName(s.backup))
		return _('Interface names may use only letters, digits and underscore, and may not begin with "wansentry_".');

	if (!s.track_ip.length)
		return _('At least one health-check host is required.');

	/* No timeout-vs-interval guard here. normalize() derives timeout as
	 * clamp(min(4, interval - 1), 1, 10, 2) from an interval already clamped to
	 * a minimum of 2, so timeout is strictly less than interval for every
	 * reachable input, including a hand-edited config and a non-numeric one.
	 * The check that used to sit here could not fail, and a check that cannot
	 * fail is worse than no check because it reads as coverage. The invariant
	 * is enforced where it is actually established, in normalize(). */

	return null;
}

/* Writes the desired model into uci's pending-change set. Idempotent by
 * construction: every option is compared before it is written, so re-applying
 * an unchanged configuration produces zero uci changes rather than a no-op
 * rewrite. Returns the number of individual uci operations performed. */
function write(s) {
	var err = validate(s);

	if (err)
		throw new Error(err);

	var state = audit();

	if (state.foreign.length)
		throw new Error(_('Refusing to write: /etc/config/mwan3 contains configuration wansentry did not create.'));

	var want = desired(s),
	    wantNames = want.map(function(d) { return d.name; }),
	    ops = 0;

	/* Adopt the package scaffolding and drop anything we used to own but no
	 * longer need, an interface section left behind when the user repoints
	 * the backup at a different uplink, for instance. */
	state.stock.concat(state.owned).forEach(function(sec) {
		if (wantNames.indexOf(sec.name) < 0) {
			uci.remove('mwan3', sec.name);
			ops++;
		}
	});

	/* Rule ORDER is load-bearing. mwan3 evaluates rules in file order and stops
	 * at the first match, so a pbr exclusion sitting behind the catch-all can
	 * never fire, and because uci.add appends, that is exactly where one
	 * created on a later apply would land.
	 *
	 * Rather than depend on uci.move's behaviour for sections that are still
	 * pending creates, drop every rule we own whenever the order is wrong and
	 * let the loop below recreate them in desired() order. The comparison is
	 * against the full desired sequence, so this fires only when the order is
	 * genuinely wrong and an unchanged re-apply still costs zero operations. */
	var haveRules = uci.sections('mwan3', 'rule')
	                   .filter(isOwned)
	                   .map(function(sec) { return sec['.name']; }),
	    wantRules = want.filter(function(d) { return d.type === 'rule'; })
	                    .map(function(d) { return d.name; });

	if (haveRules.join('\n') !== wantRules.join('\n')) {
		haveRules.forEach(function(n) {
			uci.remove('mwan3', n);
			ops++;
		});
	}

	/* Look globals up by TYPE, not by the name 'globals': mwan3 also accepts an
	 * anonymous `config globals`, which a name lookup would miss, causing a
	 * second globals section to be added that wansentry would never reconcile. */
	if (!uci.sections('mwan3', 'globals').length) {
		uci.add('mwan3', 'globals', 'globals');
		uci.set('mwan3', 'globals', 'mmx_mask', '0x3F00');
		ops += 2;
	}

	want.forEach(function(d) {
		var sec = uci.get('mwan3', d.name);

		/* A name collision with a section of a different type can only come
		 * from scaffolding we are adopting; recreate it with the right type. */
		if (sec && sec['.type'] !== d.type) {
			uci.remove('mwan3', d.name);
			sec = null;
			ops++;
		}

		if (!sec) {
			uci.add('mwan3', d.type, d.name);
			ops++;
		}

		/* Insertion order, not sorted: the same order preview() renders, so the
		 * two never disagree about how the section is laid out. */
		Object.keys(d.options).forEach(function(k) {
			if (k.charAt(0) === '.')
				return;

			var want = d.options[k];

			if (!valueEq(uci.get('mwan3', d.name, k), want)) {
				/* Clear a list before setting it. uci.set on an array can append
				 * to the already-staged list rather than replace it, which doubles
				 * use_member/track_ip on a re-apply (observed as
				 * primary,backup,primary,backup). unset-then-set forces a clean
				 * replacement, and because it only runs when the value actually
				 * differs, it also self-heals an already-doubled section on the
				 * next apply without disturbing an idempotent one. */
				if (Array.isArray(want))
					uci.unset('mwan3', d.name, k);
				uci.set('mwan3', d.name, k, want);
				ops++;
			}
		});

		optKeys(sec).forEach(function(k) {
			if (!(k in d.options)) {
				uci.unset('mwan3', d.name, k);
				ops++;
			}
		});
	});

	return ops;
}

/* --------------------------------------------------------------- preview */

/* Renders what apply will do to /etc/config/mwan3: the sections wansentry will
 * remove (stock scaffolding it adopts, plus any of its own it no longer needs),
 * the globals section it creates when one is missing, and every managed section.
 * The audience is people who read config files, so nothing apply does is hidden
 * from the preview. Option order is exactly the order write() sets them (both
 * iterate desired()'s insertion order), so the preview and the write cannot
 * disagree about section layout. */
function preview(s) {
	if (validate(s))
		return null;

	var out = [], state = audit();

	if (state.foreign.length)
		return null;                 // apply will refuse; the banner explains why

	var want = desired(s),
	    wantNames = {};

	want.forEach(function(d) { wantNames[d.name] = true; });

	state.stock.concat(state.owned).forEach(function(sec) {
		if (!wantNames[sec.name])
			out.push("# removed: %s '%s'".format(sec.type, sec.name));
	});

	if (!uci.sections('mwan3', 'globals').length)
		out.push("config globals 'globals'\n\toption mmx_mask '0x3F00'");

	want.forEach(function(d) {
		var lines = [ "config %s '%s'".format(d.type, d.name) ];

		Object.keys(d.options).forEach(function(k) {
			if (k.charAt(0) === '.')
				return;

			var v = d.options[k];

			if (Array.isArray(v))
				v.forEach(function(e) { lines.push("\tlist %s '%s'".format(k, e)); });
			else
				lines.push("\toption %s '%s'".format(k, v));
		});

		out.push(lines.join('\n'));
	});

	return out.join('\n\n');
}

return baseclass.extend({
	OWNER_OPT: OWNER_OPT,
	POLICY: POLICY,
	RULE: RULE,
	MEMBER_PRIMARY: MEMBER_PRIMARY,
	MEMBER_BACKUP: MEMBER_BACKUP,
	PBR_PREFIX: PBR_PREFIX,

	settings: settings,
	normalize: normalize,
	desired: desired,
	audit: audit,
	validate: validate,
	write: write,
	preview: preview,
	pbrClaims: pbrClaims,
	pbrRules: pbrRules,
	classify: classify,
	roleOf: roleOf,
	ifProto: ifProto,
	ifDevice: ifDevice
});
