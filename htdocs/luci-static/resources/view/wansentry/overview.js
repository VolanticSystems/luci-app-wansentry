// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 VolanticSystems

'use strict';
'require view';
'require dom';
'require poll';
'require ui';
'require uci';
'require form';
'require network';
'require fs';
'require view.wansentry.common as ws';
'require view.wansentry.generator as gen';

/*
 * wansentry, the one screen.
 *
 * Top to bottom, the way every stock LuCI page reads: the page title, any
 * banner that blocks or qualifies what follows, the live status, the settings
 * as three tabs (WAN, VPN, Notifications) under one Save & Apply, and folded
 * at the bottom the exact mwan3 configuration those settings produce and the
 * known limitations.
 *
 * One page with tabs rather than one page per tab: the generated mwan3 config
 * depends on all three sections at once, and separate pages would each get
 * their own save that the others' preview could not see.
 *
 * Saving writes /etc/config/wansentry through form.Map as usual and then runs
 * the generator (generator.js) over the freshly saved values, so both configs
 * land in the same uci apply. The mwan3 init script is enabled/started or
 * stopped/disabled afterwards, from the master toggle.
 */

var POLL_INTERVAL = 5;

function statusOf(status, name) {
	return (status && status.interfaces && status.interfaces[name]) || null;
}

/* Which uplink the failover policy is currently steering traffic to. mwan3
 * reports this by reading back its own iptables chains, so an empty result
 * means the policy is not installed at all, the service is stopped, or the
 * configuration has never been applied. */
function activeUplink(status, policyName) {
	var pol = status && status.policies && status.policies.ipv4 && status.policies.ipv4[policyName || gen.POLICY];

	if (!Array.isArray(pol) || !pol.length)
		return null;

	var best = null;

	pol.forEach(function(m) {
		if (!best || m.percent > best.percent)
			best = m;
	});

	return best ? best.interface : null;
}

/* mwan3 reports an interface that netifd has down (a stopped tunnel, an
 * unplugged USB modem) as enabled with status "disabled" and up false. That
 * read as "not tracked" here, in grey, which is the opposite of the truth:
 * the path is dead, and a dead backup is the thing this page exists to show
 * (measured on the bench 2026-10-10 by stopping a tunnel). */
function ifaceDown(st) {
	return !!(st && st.enabled && st.up === false);
}

function laneState(st) {
	if (ifaceDown(st))
		return 'down';

	if (!st || !st.enabled)
		return 'idle';

	return (st.status === 'online') ? 'up' : (st.status === 'offline' ? 'down' : 'idle');
}

/* mwan3track only writes LATENCY_<ip> / LOSS_<ip> when `check_quality` is
 * enabled; with plain up/down tracking (what wansentry generates) both files
 * stay at zero. Rendering two permanently-empty columns would be a lie, so the
 * quality columns appear only once mwan3 actually reports something. */
function hostTable(st) {
	if (!st || !Array.isArray(st.track_ip) || !st.track_ip.length)
		return E('div', { 'class': 'ws-sub' }, [ _('No health-check hosts configured.') ]);

	var quality = st.track_ip.some(function(t) { return t.latency > 0 || t.packetloss > 0; });

	var head = [ E('th', {}, [ _('Host') ]), E('th', {}, [ _('State') ]) ];

	if (quality)
		head.push(E('th', { 'class': 'ws-num' }, [ _('Latency') ]),
		          E('th', { 'class': 'ws-num' }, [ _('Loss') ]));

	return E('table', { 'class': 'ws-hosts' }, [ E('tr', {}, head) ].concat(
		st.track_ip.map(function(t) {
			var cells = [
				E('td', { 'class': 'ws-mono' }, [ t.ip ]),
				E('td', {}, [ t.status || '-' ])
			];

			if (quality)
				cells.push(E('td', { 'class': 'ws-num' }, [ '%d ms'.format(t.latency || 0) ]),
				           E('td', { 'class': 'ws-num' }, [ '%d%%'.format(t.packetloss || 0) ]));

			return E('tr', {}, cells);
		})
	));
}

/* What a lane is connected to, as one line under its name. Without it the
 * lanes said "wan" and "wwan" and nothing a person could check against the
 * world; the first question anyone asks on seeing them is which line is which.
 *
 * An uplink: its address, its gateway and the device it runs on. A tunnel:
 * the server it connects to, by host name where the config uses one, and its
 * address inside the tunnel. Both come from netifd through LuCI's network
 * module, which this page already loads; the tunnel's server comes from
 * ws.endpoints(). */
function firstAddr(list) {
	return (Array.isArray(list) && list.length) ? String(list[0]) : null;
}

function uplinkConn(net) {
	if (!net)
		return null;

	var dev = net.getL3Device ? net.getL3Device() : null,
	    addr = firstAddr(net.getIPAddrs ? net.getIPAddrs() : null),
	    gw = net.getGatewayAddr ? net.getGatewayAddr() : null,
	    devname = dev ? dev.getName() : (net.getIfname ? net.getIfname() : null);

	/* dom.append does not flatten nested arrays, so build one flat list. */
	var parts = addr ? [ E('span', { 'class': 'ws-mono ws-addr' }, [ addr ]) ] : [ _('No address') ];

	if (addr && gw)
		parts.push(' ' + _('via') + ' ', E('span', { 'class': 'ws-mono' }, [ gw ]));

	if (devname)
		parts.push(' · ', E('span', { 'class': 'ws-mono' }, [ devname ]));

	return E('div', { 'class': 'ws-conn' }, parts);
}

function tunnelConn(net, eps) {
	if (!net)
		return null;

	/* A dead tunnel has no L3 device any more, which is exactly when its
	 * server matters most, so fall back to the device it is configured on. */
	var dev = (net.getL3Device ? net.getL3Device() : null) || (net.getDevice ? net.getDevice() : null),
	    devname = dev ? dev.getName() : null,
	    ep = (devname && eps[devname]) || eps[net.getName()] || null,
	    addr = firstAddr(net.getIPAddrs ? net.getIPAddrs() : null) ||
	           firstAddr(dev && dev.getIPAddrs ? dev.getIPAddrs() : null);

	/* The device form carries a dotted netmask ("10.38.0.4/255.255.255.0"),
	 * which says nothing useful about a tunnel; the address alone does. */
	if (addr)
		addr = addr.split('/')[0];

	/* Two lines: the server, then the tunnel's own address and device. On one
	 * line a three-across card wrapped it in the middle of the address. */
	var server = ep
		? [ _('to') + ' ', E('strong', {}, [ ep.port ? '%s:%s'.format(ep.host, ep.port) : ep.host ]) ]
		: [ _('Server unknown') ];

	var inner = [];

	if (addr)
		inner.push(_('tunnel address') + ' ', E('span', { 'class': 'ws-mono ws-addr' }, [ addr ]));

	if (devname)
		inner.push(inner.length ? ' · ' : '', E('span', { 'class': 'ws-mono' }, [ devname ]));

	return E('div', { 'class': 'ws-conn' }, [
		E('div', {}, server),
		inner.length ? E('div', { 'class': 'ws-conn2' }, inner) : ''
	]);
}

/* Which path is carrying the traffic is the one thing a person opens this tab
 * to learn, and it used to be 10px grey capitals. Now a solid badge, in a
 * blue/orange pair rather than green/red: that pair stays distinct under the
 * common forms of colour blindness, and every badge also carries a word and a
 * symbol, so colour is never the only signal. */
function stateBadge(state, active) {
	if (active)
		return E('span', { 'class': 'ws-state ws-carrying' }, [ '✔ ' + _('carrying traffic') ]);

	if (state === 'down')
		return E('span', { 'class': 'ws-state ws-down' }, [ '✖ ' + _('down') ]);

	if (state === 'up')
		return E('span', { 'class': 'ws-state ws-standby' }, [ _('standby') ]);

	return E('span', { 'class': 'ws-state ws-standby' }, [ _('not tracked') ]);
}

function lane(role, name, st, active, conn) {
	if (!name)
		return E('div', { 'class': 'ws-lane' }, [
			E('div', { 'class': 'ws-lanehead' }, [
				E('span', { 'class': 'ws-lanename' }, [ _('not selected') ]),
				E('span', { 'class': 'ws-role' }, [ role ])
			]),
			E('div', { 'class': 'ws-sub' }, [ _('Pick one in the WAN config tab.') ])
		]);

	var state = laneState(st),
	    label = !st ? _('not tracked by mwan3')
	          : ifaceDown(st) ? _('interface down')
	          : st.enabled ? (st.status || 'unknown') : _('tracking disabled');

	return E('div', { 'class': 'ws-lane' + (active ? ' ws-active' : '') }, [
		E('div', { 'class': 'ws-lanehead' }, [
			E('span', { 'class': 'ws-lanename' }, [ ws.dot(state), name ]),
			E('span', { 'class': 'ws-badges' }, [
				E('span', { 'class': 'ws-role' }, [ role ]),
				stateBadge(state, active)
			])
		]),
		conn || '',
		E('dl', { 'class': 'ws-kv' }, [
			E('dt', {}, [ _('Tracking') ]), E('dd', {}, [ label ]),
			E('dt', {}, [ _('Probe state') ]), E('dd', {}, [ st ? (st.tracking || '-') : '-' ]),
			E('dt', {}, [ _('Link up for') ]), E('dd', {}, [ st ? ws.duration(st.uptime) : '-' ]),
			E('dt', {}, [ _('In this state') ]), E('dd', {}, [ st ? ws.duration(st.age) : '-' ]),
			E('dt', {}, [ _('Score / lost') ]), E('dd', {}, [ st ? '%d / %d'.format(st.score || 0, st.lost || 0) : '-' ])
		]),
		hostTable(st)
	]);
}

function eventList(events) {
	if (events === null)
		return E('div', { 'class': 'ws-sub' }, [
			_('The system log could not be read. Grant the luci-app-wansentry ACL or check that logd is running.')
		]);

	if (!events.length)
		return E('div', { 'class': 'ws-sub' }, [
			_('No uplink transitions recorded yet. mwan3 logs one line per online/offline change.')
		]);

	return E('ul', { 'class': 'ws-events' }, events.map(function(e) {
		return E('li', {}, [
			E('time', {}, [ e.time ]),
			E('span', {}, [
				ws.dot(e.state === 'online' ? 'up' : 'down'),
				_('%s went %s').format(e.iface, e.state)
			])
		]);
	}));
}

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('wansentry'),
			L.resolveDefault(uci.load('mwan3'), null),
			network.getNetworks(),
			L.resolveDefault(ws.rpc.status(), null),
			ws.events(8),
			/* pbr is optional. resolveDefault so a router without it loads
			 * exactly as before rather than failing the whole screen. */
			L.resolveDefault(uci.load('pbr'), null),
			ws.endpoints()
		]);
	},

	/* ------------------------------------------------------------ status */

	renderStatus: function(status, events) {
		var s = gen.settings(),
		    active = activeUplink(status);

		var summary;

		if (!status)
			summary = _('mwan3 is not answering on ubus. It is stopped, or rpcd has not loaded its plugin.');
		else if (!active)
			summary = _('No failover policy installed: mwan3 is not running this configuration.');
		else
			summary = _('Traffic is going out over %s.').format(active);

		var parts = [], net = L.bind(this.netOf, this);

		if (s.primary || s.backup || !gen.vpnActive(s))
			parts.push(
				E('h3', {}, [ _('WAN') ]),
				E('div', { 'class': 'ws-summary' }, [ summary ]),
				E('div', { 'class': 'ws-lanes' }, [
					lane(_('primary'), s.primary, statusOf(status, s.primary), active && active === s.primary,
					     uplinkConn(net(s.primary))),
					lane(_('backup'), s.backup, statusOf(status, s.backup), active && active === s.backup,
					     uplinkConn(net(s.backup)))
				]));

		if (gen.vpnActive(s))
			parts.push(this.renderVpnStatus(status, s));

		parts.push(
			E('h3', {}, [ _('Recent transitions') ]),
			eventList(events));

		return E('div', { 'class': 'ws-status' }, parts);
	},

	netOf: function(name) {
		return (this.networks || []).filter(function(n) { return n.getName() === name; })[0] || null;
	},

	/* One lane per tunnel, in failover order. "Carrying traffic" is read back
	 * from mwan3's live policy, the same authority the WAN lanes use; an empty
	 * policy with every tunnel down is the killswitch doing its job, and the
	 * summary says so in those words rather than leaving a blank. */
	renderVpnStatus: function(status, s) {
		var tunnels = s.vpn.tunnels,
		    activeT = activeUplink(status, gen.VPN_POLICY),
		    vpol = status && status.policies && status.policies.ipv4 && status.policies.ipv4[gen.VPN_POLICY],
		    summary;

		if (!status)
			summary = _('mwan3 is not answering on ubus.');
		else if (activeT)
			summary = _('Tunnel traffic is going out over %s.').format(activeT);
		else if (Array.isArray(vpol))
			summary = s.vpn.killswitch
				? _('Every tunnel is down. The killswitch is holding: tunnel traffic has no route until one recovers.')
				: _('Every tunnel is down. Tunnel traffic is falling back to the ordinary internet (killswitch off).');
		else
			summary = _('No VPN failover policy installed: mwan3 is not running this configuration.');

		var self = this;

		return E([], [
			E('h3', {}, [ _('VPN') ]),
			E('div', { 'class': 'ws-summary' }, [ summary ]),
			E('div', { 'class': 'ws-lanes' }, tunnels.map(function(t, i) {
				return lane(i === 0 ? _('first choice') : _('backup %d').format(i), t,
				            statusOf(status, t), activeT && activeT === t,
				            tunnelConn(self.netOf(t), self.endpoints || {}));
			}))
		]);
	},

	refresh: function() {
		var self = this;

		/* Addresses change (a DHCP renewal, a tunnel reconnecting), so the
		 * netifd view is re-read with the status rather than kept from load. */
		network.flushCache();

		return Promise.all([
			L.resolveDefault(ws.rpc.status(), null),
			ws.events(8),
			L.resolveDefault(network.getNetworks(), null)
		]).then(function(r) {
			if (r[2])
				self.networks = r[2];

			dom.content(self.statusNode, self.renderStatus(r[0], r[1]));
		});
	},

	/* ------------------------------------------------------------ blocks */

	renderBanners: function(mwan3Loaded, audit) {
		var out = [], s = gen.settings();

		if (!mwan3Loaded) {
			/* The mwan3 config could not be loaded. Usually that means the package
			 * is not installed, but a transient rpcd/uci read failure lands here
			 * too, so the banner names both rather than asserting the cause. */
			out.push(ws.note('error', _('mwan3 configuration is not available'), [
				E('span', {}, [ _('wansentry generates mwan3 configuration; it does not replace it. This usually means the mwan3 package is not installed (install it and reload the page); if it is installed, its configuration could not be read just now, so reload and try again.') ])
			]));

			return out;
		}

		if (audit.foreign.length) {
			out.push(ws.note('error', _('Manual mwan3 configuration present, and wansentry will not touch it'), [
				E('p', { 'style': 'margin:.3em 0' }, [
					_('/etc/config/mwan3 contains sections wansentry did not create. Rather than merge with a configuration somebody wrote by hand, wansentry refuses to write anything at all and leaves this screen read-only.')
				]),
				E('p', { 'style': 'margin:.3em 0' }, [
					_('Foreign sections:') , ' ',
					E('span', { 'class': 'ws-mono' }, [
						audit.foreign.map(function(f) { return f.type + ' ' + f.name; }).join(', ')
					])
				]),
				E('p', { 'style': 'margin:.3em 0' }, [
					_('Remove them (or reset mwan3 to its packaged defaults) to let wansentry take over. This banner also appears if a newer mwan3 release ships defaults wansentry does not recognise; refusing is the safe direction.')
				])
			]));

			return out;
		}

		/* mwan3 runs when EITHER half is on (init.d/wansentry reconcile()), so
		 * "the service is stopped" is only true when both are off. */
		if (!s.enabled && !gen.vpnActive(s))
			out.push(ws.note('warn', _('Failover is switched off'), [
				E('span', {}, [ _('mwan3 is stopped and disabled, so routing behaves exactly as it did before wansentry was installed. Switch failover on in the WAN config or VPN config tab to arm it.') ])
			]));

		if (audit.stock.length)
			out.push(ws.note('info', _('mwan3 is carrying its packaged example configuration'), [
				E('span', {}, [
					_('%d sections shipped by the mwan3 package (the wan/wanb/balanced example) will be removed on the next apply and replaced by the failover configuration below.').format(audit.stock.length)
				])
			]));

		/* Policy-based routing coexistence. Both packages mark packets, but the
		 * marks do not collide, pbr uses 0x00ff0000 and mwan3 0x00003f00. What
		 * collides is ip rule PRIORITY: mwan3 sits at 1001-3002 and pbr at
		 * 29995-30000, so mwan3 is consulted first and pbr's decision never
		 * runs. Measured on the bench: a client inside a pbr policy's range
		 * exits by the plain WAN instead of the tunnel the policy names, and
		 * neither package logs a thing. The generator emits exclusion rules to
		 * prevent it; this says so, because a silent fix is indistinguishable
		 * from no fix when someone is trying to work out what their router is
		 * doing. */
		var pbr = gen.pbrClaims();

		if (pbr.claims.length) {
			var policies = [];

			pbr.claims.forEach(function(c) {
				if (policies.indexOf(c.policy) < 0)
					policies.push(c.policy);
			});

			out.push(ws.note('info', _('Policy-based routing detected'), [
				E('p', { 'style': 'margin:.3em 0' }, [
					_('pbr is installed and active. Without help the two packages fight: mwan3 installs its routing rules at a far lower priority than pbr, so mwan3 is consulted first and pbr\'s policies never run. Traffic keeps flowing, nothing is logged, and it simply stops going where you sent it.')
				]),
				E('p', { 'style': 'margin:.3em 0' }, [
					_('%d exclusion rule(s) will be generated so mwan3 leaves the traffic these policies claim alone: %s. Everything else still fails over normally.').format(pbr.claims.length, policies.join(', '))
				])
			]));
		}

		if (pbr.skipped.length)
			out.push(ws.note('warn',_('Some pbr policies cannot be protected'), [
				E('span', {}, [
					_('These pbr policies match on neither a source nor a destination address, so they claim all traffic: %s. An mwan3 rule mirroring one would match every packet on this router, including the tunnel\'s own, and switch failover off while appearing to configure it. They are left alone instead, which means failover may override them. Give each one a source or destination range if you need it protected.').format(pbr.skipped.join(', '))
				])
			]));

		return out;
	},

	renderLimits: function() {
		return E('div', {}, [
			ws.note('info', _('DNS can still be answered through the dead uplink'), [
				E('p', { 'style': 'margin:.3em 0' }, [
					_('dnsmasq merges the resolvers learned from every interface that is up into one runtime resolv file and picks between them without regard to failover state. After a switchover, name resolution can still be attempted through the uplink that just died, so the network looks broken even though routing is correct. mwan3 does not solve this either; wansentry does not pretend to.')
				]),
				E('p', { 'style': 'margin:.3em 0' }, [
					_('The usual workaround is to stop dnsmasq using the merged file and give it a fixed upstream instead:')
				]),
				E('pre', { 'class': 'ws-pre' }, [
					"uci set dhcp.@dnsmasq[0].resolvfile=''\n" +
					"uci add_list dhcp.@dnsmasq[0].server='1.1.1.1'\n" +
					"uci add_list dhcp.@dnsmasq[0].server='8.8.8.8'\n" +
					"uci set dhcp.@dnsmasq[0].noresolv='1'\n" +
					"uci commit dhcp && /etc/init.d/dnsmasq restart"
				]),
				E('p', { 'class': 'ws-sub', 'style': 'margin:.4em 0 0' }, [
					_('Those resolvers are then reached over whichever uplink the failover policy has selected, which is the behaviour you want. wansentry deliberately does not apply this for you: it rewrites DNS for the whole router and that is not a decision a failover screen should make silently.')
				])
			]),
			ws.note('info', _('IPv6 is generated but has not been failover-tested'), [
				E('span', {}, [
					_('When an uplink has an IPv6 partner (wan and wan6), both halves are generated so IPv6 fails over with IPv4. The generated configuration is checked by the test suite, but no live IPv6 failover has been measured, and VPN failover is IPv4 only.')
				])
			]),
			ws.note('info', _('Flow offloading blunts the conntrack flush'), [
				E('span', {}, [
					_('With software or hardware flow offloading enabled in the firewall, established connections take a kernel fast path that skips netfilter, so they can survive a switchover even with the conntrack flush turned on. If you run offloading and want clean failover, expect to add a selective flush hook in /etc/mwan3.user.')
				])
			])
		]);
	},

	/* ------------------------------------------------------------ render */

	render: function(data) {
		var self = this,
		    mwan3Loaded = (data[1] !== null),
		    networks = data[2],
		    status = data[3],
		    events = data[4];

		self.networks = networks;
		self.endpoints = data[6] || {};

		ws.injectCSS();

		var audit = gen.audit(),
		    blocked = (!mwan3Loaded || audit.foreign.length > 0);

		/* Remembered for handleSave(). audit() cannot tell "mwan3 holds nothing
		 * foreign" from "mwan3 never loaded": uci.sections() returns [] for
		 * both, and L.resolveDefault() flattens a missing package, an ACL gap, a
		 * transient rpcd failure and an unparseable /etc/config/mwan3 into the
		 * same null. The last of those is the dangerous one, because that is
		 * precisely when a foreign hand-built config DOES exist and the
		 * ownership check cannot see it. m.readonly below already blocks the
		 * form, but that is a rendering decision; the promise not to touch a
		 * stranger's mwan3 is enforced in the save path itself. */
		self.mwan3Loaded = mwan3Loaded;

		/* A COMMENT THAT USED TO SIT HERE WAS WRONG, and recording that is worth
		 * more than deleting it quietly. It claimed getProtocol() was sufficient
		 * without granting uci read on `network`, because LuCI's
		 * enumerateNetworks() falls back to the netifd dump and would supply the
		 * protocol anyway. It does not. Loaded as a genuinely restricted user,
		 * getProtocol() returned empty for every interface, so every label lost
		 * its protocol and device and the dhcpv6 filter failed OPEN and offered
		 * wan6 as a candidate uplink.
		 *
		 * The claim said "verified on hardware", and it had been, as root. Root
		 * can read /etc/config/network, so the fallback was never exercised. The
		 * fix reads netifd through _ubus(), which is how LuCI's own isUp() works
		 * and needs no extra call. See generator.js ifProto(). */
		/* The classifier lives in generator.js so it can be tested under Node.
		 * It used to sit here, where the only way to check it was to look at it
		 * in a browser, and a real bug survived that: loaded as a genuinely
		 * restricted user, every label lost its protocol and device and the
		 * IPv6 filter failed open, offering wan6 as a candidate uplink.
		 *
		 * A saved selection is passed in so it can never become unselectable. */
		var chosen = [ uci.get('wansentry', 'main', 'primary'),
		               uci.get('wansentry', 'main', 'backup') ];
		
		var cls = gen.classify(networks, chosen,
		                       uci.get('wansentry', 'main', 'show_all_interfaces') === '1');
		
		var classified = cls.all,
		    eligible   = cls.eligible,
		    forceAll   = cls.forceAll,
		    choices    = cls.choices;
		
		self.classified = classified;

		/* ------------------------------------------------------- the form */

		/* form.Map REBUILDS its whole node after a plain Save (load, then
		 * renderContents again), so anything inserted into it from outside is
		 * wiped. 1.2.1 inserted the banners and the status that way and lost
		 * both on the first Save. The banners are now added inside
		 * renderContents itself, so every rebuild puts them back, between the
		 * description and the tabs. */
		var BannerMap = form.Map.extend({
			renderContents: function() {
				return this.super('renderContents', arguments).then(function(mapEl) {
					var head = mapEl.querySelector('.cbi-map-descr') || mapEl.querySelector('h2'),
					    banners = E('div', { 'class': 'ws-banners' }, self.renderBanners(mwan3Loaded, audit)),
					    old = mapEl.querySelector('.ws-banners');

					if (old)
						old.parentNode.removeChild(old);

					if (head)
						head.parentNode.insertBefore(banners, head.nextSibling);
					else
						mapEl.insertBefore(banners, mapEl.firstChild);

					/* The rebuild also replaced every widget, so the live
					 * preview's listeners are gone with the old ones. On the
					 * first render self.map is not set yet and render() hooks
					 * them itself. */
					if (self.map) {
						self.hookPreview();
						self.renderPreview();
					}

					return mapEl;
				});
			}
		});

		/* The live status as the first tab. A section with no options: it
		 * renders the status node, which persists across rebuilds because the
		 * poller keeps filling the same node. Nothing to parse or save. */
		var StatusSection = form.NamedSection.extend({
			render: function() {
				return E('div', {
					'class': 'cbi-section',
					'data-tab': 'status',
					'data-tab-title': this.title
				}, [
					E('div', { 'class': 'cbi-section-descr' }, [ this.description ]),
					self.statusNode
				]);
			}
		});

		self.statusNode = E('div', {}, self.renderStatus(status, events));

		var m = new BannerMap('wansentry', _('WAN and VPN Failover'),
			_('Switches to a backup internet uplink when the primary fails, and to the next VPN tunnel when one dies, by generating the mwan3 configuration that does it. The uplinks and tunnels must already exist; this page only decides which one carries the traffic.'));

		m.readonly = blocked;

		/* Each section is a tab, the stock LuCI way (form.Map.tabbed, as on
		 * other multi-section pages). The tab label is the section title, and
		 * hidetitle keeps that title from being repeated as a heading inside
		 * its own tab. */
		m.tabbed = true;

		m.section(StatusSection, 'main', 'status', _('Status'),
			_('Live, refreshed every %d seconds.').format(POLL_INTERVAL));

		var s = m.section(form.NamedSection, 'main', 'wansentry', _('WAN config'),
			_('One primary uplink, one backup, and a health check that decides between them.'));
		s.hidetitle = true;
		var o;

		o = s.option(form.Flag, 'enabled', _('Enable WAN failover'),
			_('Off: the uplinks route exactly as they did before wansentry. Independent of VPN failover.'));
		o.rmempty = false;

		o = s.option(form.ListValue, 'primary', _('Primary interface'),
			_('The uplink traffic uses whenever its health check passes.'));
		o.value('', _('-- please select --'));
		choices.forEach(function(c) { o.value(c[0], c[1]); });

		o = s.option(form.ListValue, 'backup', _('Backup interface'),
			_('Used only while the primary is down. It must already exist as a working interface with its own gateway.'));
		o.value('', _('-- please select --'));
		choices.forEach(function(c) { o.value(c[0], c[1]); });

		o = s.option(form.DynamicList, 'track_ip', _('Health-check hosts'),
			_('Pinged through each uplink. Use two hosts on different operators: an uplink counts as up while any one of them answers.'));
		/* nomask: a bare host address only. Without it 'ip4addr' accepts
		 * 8.8.8.8/24, which mwan3track would then try to ping as a non-address. */
		o.datatype = 'ip4addr("nomask")';
		o.rmempty = false;

		o = s.option(form.Value, 'interval', _('Check interval'),
			_('Seconds between probes.'));
		o.datatype = 'range(2,3600)';
		o.placeholder = '5';
		o.rmempty = false;

		o = s.option(form.Value, 'down', _('Failure threshold'),
			_('Failed checks in a row before an uplink is declared down. Interval × threshold is the worst-case detection time.'));
		o.datatype = 'range(1,100)';
		o.placeholder = '3';
		o.rmempty = false;

		o = s.option(form.Value, 'up', _('Recovery threshold'),
			_('Good checks in a row before an uplink is used again. Keep it above the failure threshold so a shaky primary does not flap.'));
		o.datatype = 'range(1,100)';
		o.placeholder = '6';
		o.rmempty = false;

		o = s.option(form.Flag, 'failback', _('Return to primary when it recovers'),
			_('On: traffic moves back as soon as the primary recovers. Off: each client stays on the backup for up to 10 minutes after its last packet; this softens failback, it cannot prevent it.'));
		o.rmempty = false;

		o = s.option(form.Flag, 'flush_conntrack', _('Flush connection tracking on switchover'),
			_('Recommended. Drops open connections on a switchover so clients reconnect over the working uplink instead of retrying a dead one for minutes. Connections on the healthy uplink are dropped too.'));
		o.rmempty = false;

		/* Last on the tab: it is a repair for a missing uplink, not a setting
		 * most people ever touch. */
		o = s.option(form.Flag, 'show_all_interfaces', _('Show every interface'),
			forceAll
				? _('Forced on: fewer than two interfaces look like uplinks, or a saved choice would otherwise be hidden.')
				: _('Only interfaces that look like uplinks are offered above. Turn this on if yours is missing; the guess can be wrong when an ISP delivers the uplink over a tunnel.'));
		o.rmempty = false;

		/* `|| blocked`, and the assignment is the whole reason this comment
		 * exists. LuCI resolves a widget's readonly state from the option
		 * first and falls back to the Map only when the option leaves it
		 * undefined, so assigning `forceAll` alone WRITES FALSE when the
		 * screen is blocked, overriding `m.readonly = blocked` set above and
		 * leaving this one control live on a read-only screen.
		 *
		 * It writes nothing on its own, so the ownership guarantee held, but
		 * it contradicted the screen's own claim that every input is disabled
		 * when foreign mwan3 config is present, and that claim is the reason
		 * an operator trusts the banner. Any option that sets its own readonly
		 * has to carry `|| blocked` for the same reason. */
		o.readonly = forceAll || blocked;

		/* Rebuild both dropdowns in place when the toggle flips, so the effect
		 * is immediate rather than waiting for a save and a reload. Every step
		 * is guarded: on any LuCI version where these widget methods are not
		 * available the toggle simply takes effect on the next page load, which
		 * is a lesser experience and not a broken one. */
		o.onchange = function(ev, section_id, value) {
			var list = (value === '1' || forceAll) ? classified : eligible;

			[ 'primary', 'backup' ].forEach(function(name) {
				var opt = s.getOption ? s.getOption(name) : null,
				    el = (opt && opt.getUIElement) ? opt.getUIElement(section_id) : null;

				if (!el || !el.clearChoices || !el.addChoices)
					return;

				var cur = el.getValue(),
				    keys = [ '' ],
				    labels = { '': _('-- please select --') };

				list.forEach(function(c) {
					keys.push(c.name);
					labels[c.name] = c.label;
				});

				/* Never drop a selection off the list. Narrowing the choices
				 * out from under a value the user already picked would blank
				 * the field on the next save without ever saying so. */
				if (cur && keys.indexOf(cur) < 0) {
					var kept = classified.filter(function(c) { return c.name === cur; })[0];

					keys.push(cur);
					labels[cur] = kept ? kept.label : cur;
				}

				el.clearChoices(true);
				el.addChoices(keys, labels);
				el.setValue(cur);
			});
		};

		/* ------------------------------------------------- VPN failover */

		var vs = m.section(form.NamedSection, 'vpn', 'vpn', _('VPN config'),
			_('For traffic that policy-based routing (pbr) already sends into a VPN tunnel: when that tunnel dies, move the traffic to the next one, and block it if every tunnel is dead. pbr still decides which traffic uses a tunnel.'));
		vs.hidetitle = true;

		o = vs.option(form.Flag, 'enabled', _('Enable VPN failover'),
			_('Independent of WAN failover: either, both or neither can be on.'));
		o.rmempty = false;

		/* Every option below depends on this flag, and LuCI DELETES a hidden
		 * option's value on save unless it is marked `retain`. Without it,
		 * switching VPN failover off erased the tunnel list, the health-check
		 * hosts and the timings, and switching it back on showed them empty
		 * (found on the sandbox 2026-10-09). The WAN half has no depends, so it
		 * never had this problem. */

		var tunnelChoices = classified.filter(function(c) { return c.role === 'tunnel'; });

		o = vs.option(form.DynamicList, 'tunnel', _('Tunnels, in order'),
			_('The first carries the traffic while it is healthy; the rest are tried in this order. At least two.'));
		tunnelChoices.forEach(function(c) { o.value(c.name, c.base); });
		o.depends('enabled', '1');
		o.retain = true;

		o = vs.option(form.DynamicList, 'track_ip', _('Health-check hosts'),
			_('Pinged through each tunnel. Use two hosts on different operators: a tunnel counts as up while any one of them answers.'));
		o.datatype = 'ip4addr("nomask")';
		o.depends('enabled', '1');
		o.retain = true;

		o = vs.option(form.Value, 'interval', _('Check interval'),
			_('Seconds between probes. After a failed probe they come every 2 seconds, so a dead tunnel is declared in about 15 to 20 seconds at the defaults.'));
		o.datatype = 'range(2,3600)';
		o.placeholder = '5';
		o.depends('enabled', '1');
		o.retain = true;

		o = vs.option(form.Value, 'down', _('Failure threshold'),
			_('Failed checks in a row before a tunnel is declared dead.'));
		o.datatype = 'range(1,100)';
		o.placeholder = '3';
		o.depends('enabled', '1');
		o.retain = true;

		o = vs.option(form.Value, 'up', _('Recovery threshold'),
			_('Good checks in a row before a tunnel is used again.'));
		o.datatype = 'range(1,100)';
		o.placeholder = '3';
		o.depends('enabled', '1');
		o.retain = true;

		o = vs.option(form.Flag, 'killswitch', _('Block tunnel traffic when every tunnel is down'),
			_('Recommended. While every tunnel is dead, tunnel traffic is blocked instead of leaving over the ordinary internet.'));
		o.default = '1';
		o.rmempty = false;
		o.depends('enabled', '1');
		o.retain = true;

		/* -------------------------------------------------- notifications */

		var ns = m.section(form.NamedSection, 'notify', 'notify', _('Notifications'),
			_('A failover that works is quiet, so a dead backup goes unnoticed until it is needed. This emails you whenever an uplink or tunnel goes down or comes back, plus a daily report of every path.'));
		ns.hidetitle = true;

		o = ns.option(form.Flag, 'enabled', _('Send notifications'));
		o.rmempty = false;

		o = ns.option(form.Value, 'to', _('Send to'));
		o.datatype = 'string';
		o.placeholder = 'you@example.com';

		o = ns.option(form.Value, 'from', _('Send as'),
			_('The From address. When logging in, many mail servers require it to match the login.'));
		o.placeholder = 'router@example.com';

		o = ns.option(form.Value, 'server', _('SMTP server'));
		o.datatype = 'host';
		o.placeholder = 'smtp.example.com';

		o = ns.option(form.Value, 'port', _('SMTP port'),
			_('587 for STARTTLS, 465 for implicit TLS.'));
		o.datatype = 'port';
		o.placeholder = '587';

		o = ns.option(form.Flag, 'tls', _('Use TLS'));
		o.default = '1';
		o.rmempty = false;

		/* Optional, the way a mail client asks it. A mail server accepts mail
		 * for its own mailboxes without a login; only relaying to other
		 * domains needs one. A config saved before this option existed has
		 * no `auth`, so it is read as on exactly when a login was filled in,
		 * which is what the script did then (notify, the same fallback). */
		o = ns.option(form.Flag, 'auth', _('Server requires authentication'),
			_('Off: no login is sent. Most mail servers accept that only for mail to their own addresses, so it suits sending to a mailbox on the same server.'));
		o.rmempty = false;
		o.cfgvalue = function(section_id) {
			var v = uci.get('wansentry', section_id, 'auth');

			return (v != null) ? v : (uci.get('wansentry', section_id, 'username') ? '1' : '0');
		};

		o = ns.option(form.Value, 'username', _('SMTP login'));
		o.depends('auth', '1');
		o.retain = true;

		o = ns.option(form.Value, 'password', _('SMTP password'),
			_('Stored in plain text in /etc/config/wansentry. Use an account made for this.'));
		o.password = true;
		o.depends('auth', '1');
		o.retain = true;

		o = ns.option(form.Flag, 'daily', _('Daily report'),
			_('One email a day listing every uplink and tunnel and whether it is up.'));
		o.default = '1';
		o.rmempty = false;

		o = ns.option(form.ListValue, 'daily_hour', _('Daily report at'),
			_('Router local time.'));
		for (var h = 0; h < 24; h++)
			o.value(String(h), '%02d:00'.format(h));
		o.default = '8';
		o.depends('daily', '1');
		o.retain = true;

		o = ns.option(form.Button, '_test', _('Test'),
			_('Uses the saved settings, so save first. Works even while notifications are switched off.'));
		o.inputtitle = _('Send test email');
		o.inputstyle = 'action';
		o.onclick = function() {
			return fs.exec('/usr/libexec/wansentry/notify', [ 'test' ]).then(function(res) {
				ui.addNotification(null, E('p', {}, [
					(res && res.code === 0)
						? _('Test email handed to the mail server. If it does not arrive, check the spam folder and the system log (logread -e wansentry).')
						: _('Sending failed. The reason is in the system log: logread -e wansentry')
				]), (res && res.code === 0) ? 'info' : 'danger');
			}).catch(function(e) {
				ui.addNotification(null, E('p', {}, [ e.message ]), 'danger');
			});
		};

		return m.render().then(function(mapNode) {
			self.map = m;

			poll.add(L.bind(self.refresh, self), POLL_INTERVAL);

			self.previewNode = E('div', {});
			self.renderPreview();

			/* Live preview: re-render whenever any widget changes. m.render()
			 * has resolved, so the option widgets exist; hooking each one's
			 * change/keyup event keeps the "Generated mwan3 configuration" card
			 * in step with the form instead of showing the last-applied values.
			 * gen.settings() reads uci (stale until save), so the preview is fed
			 * the LIVE widget values via liveSettings() instead. */
			self.hookPreview();

			/* Reference material, folded: it is not a setting, and left open it
			 * made the page read as one long list. */
			return E([], [
				mapNode,

				ws.section(_('Details'), null, E('div', {}, [
					ws.fold(_('Generated mwan3 configuration'),
						_('What Save & Apply writes to /etc/config/mwan3, updated as you edit.'),
						self.previewNode),
					ws.fold(_('Known limitations'), null, self.renderLimits())
				]))
			]);
		});
	},

	/* Build a raw {opt: value} map from the current widget values and normalise
	 * it the same way a uci read would be, so the preview matches exactly what a
	 * save would generate. */
	liveSettings: function() {
		var m = this.map;
		var fv = function(name, sid) {
			sid = sid || 'main';
			var o = m && m.lookupOption ? m.lookupOption(name, sid) : null;
			return (o && o[0]) ? o[0].formvalue(sid) : null;
		};

		return gen.normalize({
			enabled:         fv('enabled'),
			primary:         fv('primary'),
			backup:          fv('backup'),
			track_ip:        fv('track_ip'),
			interval:        fv('interval'),
			down:            fv('down'),
			up:              fv('up'),
			failback:        fv('failback'),
			flush_conntrack: fv('flush_conntrack'),
			vpn_enabled:     fv('enabled', 'vpn'),
			vpn_tunnel:      fv('tunnel', 'vpn'),
			vpn_track_ip:    fv('track_ip', 'vpn'),
			vpn_interval:    fv('interval', 'vpn'),
			vpn_down:        fv('down', 'vpn'),
			vpn_up:          fv('up', 'vpn'),
			vpn_killswitch:  fv('killswitch', 'vpn')
		});
	},

	renderPreview: function() {
		if (!this.previewNode)
			return;

		var text = gen.preview(this.liveSettings());

		dom.content(this.previewNode, text
			? E('pre', { 'class': 'ws-pre' }, [ text ])
			: E('div', { 'class': 'ws-sub' }, [ _('Complete the settings above to see the configuration this screen will generate.') ]));
	},

	hookPreview: function() {
		var self = this, m = this.map;
		var opts = [ 'enabled', 'primary', 'backup', 'track_ip',
		             'interval', 'down', 'up', 'failback', 'flush_conntrack' ]
		           .map(function(n) { return [ n, 'main' ]; })
		           .concat([ 'enabled', 'tunnel', 'track_ip', 'interval', 'down', 'up', 'killswitch' ]
		           .map(function(n) { return [ n, 'vpn' ]; }));
		var update = function() { self.renderPreview(); };

		opts.forEach(function(pair) {
			var name = pair[0], sid = pair[1];
			var o = m.lookupOption ? m.lookupOption(name, sid) : null;
			var w = (o && o[0]) ? o[0].getUIElement(sid) : null;
			var node = w && w.node ? w.node : null;

			/* 'change' and 'keyup' cover plain inputs. LuCI's own widgets do NOT
			 * fire 'change': a DynamicList dispatches 'cbi-dynlist-change' and a
			 * dropdown 'cbi-dropdown-change' (read from ui.js). Listening only
			 * for 'change' left the preview stale whenever a tunnel or a
			 * health-check host was added or removed, which is the one edit the
			 * preview most needs to show. Found on the bench 2026-10-08: three
			 * tunnels added, preview still said "complete the settings". */
			if (node) {
				[ 'change', 'keyup', 'cbi-dynlist-change', 'cbi-dropdown-change', 'widget-change' ]
					.forEach(function(ev) { node.addEventListener(ev, update); });
			}
		});
	},

	/* ------------------------------------------------------------- apply */

	/* form.Map.save() writes /etc/config/wansentry into uci's pending change
	 * set; the generator then reads those pending values straight back and
	 * writes /etc/config/mwan3 alongside them, so one apply commits both. */
	handleSave: function(ev) {
		var self = this;

		/* Everything that can refuse the save runs BEFORE map.save() stages
		 * anything, so the operation stays all-or-nothing. map.save() pushes
		 * /etc/config/wansentry into the pending set server-side; if the generator
		 * then threw, those wansentry changes would linger and could ride out on a
		 * later Apply from any other LuCI page, committing an enabled failover with
		 * no mwan3 config behind it. Two doors lead there and both are shut here:
		 *   - foreign mwan3 config (does not depend on the form's values), and
		 *   - form validation (identical or empty interfaces), checked against the
		 *     LIVE widget values via liveSettings() since uci is stale until save. */
		/* An empty audit is only meaningful if mwan3 actually loaded. See
		 * render(): unset means unknown, and unknown is not permission. */
		if (!self.mwan3Loaded) {
			ui.addNotification(null, E('p', {}, [
				_('Refusing to save: /etc/config/mwan3 could not be read, so wansentry cannot tell whether it would be overwriting configuration it did not create.')
			]), 'danger');

			return Promise.resolve(false);
		}

		var state = gen.audit();

		if (state.foreign.length) {
			ui.addNotification(null, E('p', {}, [
				_('Refusing to save: /etc/config/mwan3 contains configuration wansentry did not create.')
			]), 'danger');

			return Promise.resolve(false);
		}

		var verr = gen.validate(this.liveSettings());

		if (verr) {
			ui.addNotification(null, E('p', {}, [ verr ]), 'danger');

			return Promise.resolve(false);
		}

		return this.map.save(null, true).then(function() {
			gen.write(gen.settings());

			/* form.Map.save() pushes its own changes to the server, but the
			 * mwan3 sections the generator just staged are still browser-side
			 * only until this second save. */
			return uci.save();
		}).then(function() {
			return true;
		}).catch(function(e) {
			ui.addNotification(null, E('p', {}, [ e.message ]), 'danger');

			return false;
		});
	},

	handleSaveApply: function(ev, mode) {
		return this.handleSave(ev).then(function(ok) {
			if (!ok)
				return;

			/* Hand the commit to LuCI's own apply flow, and do NOT touch the
			 * mwan3 service from here. It owns the rollback-protected commit, the
			 * confirm countdown, and the reload, driven from this document so the
			 * confirm cannot be lost to an early reload (the bug a manual
			 * uci.apply().then(reload) walks into). Service enable/disable is
			 * reconciled router-side by /etc/init.d/wansentry on the wansentry
			 * reload trigger: init-script symlinks are not covered by UCI
			 * rollback, so managing them from the browser could leave the service
			 * and the config disagreeing after a rolled-back apply. Reconciling
			 * from the committed config keeps them in lockstep and self-heals at
			 * boot. */
			return ui.changes.apply(true);
		});
	},

	handleReset: null
});
