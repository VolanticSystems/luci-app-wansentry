// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 VolanticSystems

'use strict';
'require baseclass';
'require uci';

/*
 * wansentry — the mwan3 configuration generator.
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
 *   3. Anything else is foreign. wansentry refuses to apply at all — it does
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

var MANAGED_TYPES = [ 'interface', 'member', 'policy', 'rule' ];

/* The mwan3 package's shipped /etc/config/mwan3 (verified against
 * mwan3 2.12.0-r3 on OpenWrt 25.12.5). Section names alone are not enough to
 * identify scaffolding — a user configuring mwan3 through luci-app-mwan3 edits
 * exactly these sections — so every option value is part of the fingerprint. */
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

	/* Floor of 2: the form's datatype is range(2,3600) and validate() requires
	 * interval > timeout (min timeout 1), so 1 could never be produced by the
	 * UI and must not slip in from a hand-edited config either. */
	var interval = clamp(g('interval', '5'), 2, 3600, 5);

	return {
		enabled:  g('enabled', '0') === '1',
		primary:  g('primary', ''),
		backup:   g('backup', ''),
		track_ip: L.toArray(raw.track_ip),
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

/* --------------------------------------------------- desired mwan3 model */

function trackOptions(s) {
	var o = {
		enabled:           s.enabled ? '1' : '0',
		family:            'ipv4',
		initial_state:     'online',
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

	return [
		{ name: s.primary, type: 'interface', options: trackOptions(s) },
		{ name: s.backup,  type: 'interface', options: trackOptions(s) },
		{ name: MEMBER_PRIMARY, type: 'member', options: member(s.primary, '1') },
		{ name: MEMBER_BACKUP,  type: 'member', options: member(s.backup,  '2') },
		{ name: POLICY, type: 'policy', options: policy },
		{ name: RULE,   type: 'rule',   options: rule }
	];
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

	if (parseInt(s.timeout, 10) >= parseInt(s.interval, 10))
		return _('The check interval must be at least two seconds.');

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
	 * longer need — an interface section left behind when the user repoints
	 * the backup at a different uplink, for instance. */
	state.stock.concat(state.owned).forEach(function(sec) {
		if (wantNames.indexOf(sec.name) < 0) {
			uci.remove('mwan3', sec.name);
			ops++;
		}
	});

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
			if (!valueEq(uci.get('mwan3', d.name, k), d.options[k])) {
				uci.set('mwan3', d.name, k, d.options[k]);
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

	settings: settings,
	normalize: normalize,
	desired: desired,
	audit: audit,
	validate: validate,
	write: write,
	preview: preview
});
