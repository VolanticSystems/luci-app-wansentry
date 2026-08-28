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
'require view.wansentry.common as ws';
'require view.wansentry.generator as gen';

/*
 * wansentry, the one screen.
 *
 * Top to bottom: any banner that blocks or qualifies what follows, the live
 * failover status, the ten settings, the exact mwan3 configuration those
 * settings produce, and an honest list of what v1 does not solve.
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
function activeUplink(status) {
	var pol = status && status.policies && status.policies.ipv4 && status.policies.ipv4[gen.POLICY];

	if (!Array.isArray(pol) || !pol.length)
		return null;

	var best = null;

	pol.forEach(function(m) {
		if (!best || m.percent > best.percent)
			best = m;
	});

	return best ? best.interface : null;
}

function laneState(st) {
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

function lane(role, name, st, active) {
	if (!name)
		return E('div', { 'class': 'ws-lane' }, [
			E('div', { 'class': 'ws-lanehead' }, [
				E('span', { 'class': 'ws-lanename' }, [ _('not selected') ]),
				E('span', { 'class': 'ws-role' }, [ role ])
			]),
			E('div', { 'class': 'ws-sub' }, [ _('Pick an interface below.') ])
		]);

	var state = laneState(st),
	    label = st ? (st.enabled ? (st.status || 'unknown') : _('tracking disabled')) : _('not tracked by mwan3');

	return E('div', { 'class': 'ws-lane' + (active ? ' ws-active' : '') }, [
		E('div', { 'class': 'ws-lanehead' }, [
			E('span', { 'class': 'ws-lanename' }, [ ws.dot(state), name ]),
			E('span', { 'class': 'ws-role' }, [ active ? _('%s · carrying traffic').format(role) : role ])
		]),
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
			L.resolveDefault(uci.load('pbr'), null)
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

		return E('div', {}, [
			E('div', { 'class': 'ws-sub', 'style': 'margin:0 0 .8em' }, [ summary ]),
			E('div', { 'class': 'ws-lanes' }, [
				lane(_('primary'), s.primary, statusOf(status, s.primary), active && active === s.primary),
				lane(_('backup'), s.backup, statusOf(status, s.backup), active && active === s.backup)
			]),
			E('h4', { 'style': 'margin:1.2em 0 .4em;font-size:12px' }, [ _('Recent uplink transitions') ]),
			eventList(events)
		]);
	},

	refresh: function() {
		var self = this;

		return Promise.all([
			L.resolveDefault(ws.rpc.status(), null),
			ws.events(8)
		]).then(function(r) {
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

		if (!s.enabled)
			out.push(ws.note('warn', _('Failover is switched off'), [
				E('span', {}, [ _('The generated mwan3 interfaces are written with tracking disabled and the mwan3 service is stopped and disabled on apply, so routing behaves exactly as it did before wansentry was installed. Turn on "Enable failover" below to arm it.') ])
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
			out.push(ws.note('warning', _('Some pbr policies cannot be protected'), [
				E('span', {}, [
					_('These pbr policies match on neither a source nor a destination address, so they claim all traffic: %s. An mwan3 rule mirroring one would match every packet on this router, including the tunnel\'s own, and switch failover off while appearing to configure it. They are left alone instead, which means failover may override them. Give each one a source or destination range if you need it protected.').format(pbr.skipped.join(', '))
				])
			]));

		return out;
	},

	renderLimits: function() {
		return ws.card(_('Known limitations in v1'), null, E('div', {}, [
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
			ws.note('info', _('IPv6 is out of scope'), [
				E('span', {}, [
					_('wansentry generates IPv4 sections only. IPv6 failover moves on router advertisements and DHCPv6-PD state rather than a default-route metric, clients keep stale addresses for minutes, and mwan3 itself has several open defects there. Any IPv6 default route on this router keeps using ordinary kernel routing, untouched by the generated policy.')
				])
			]),
			ws.note('info', _('Flow offloading blunts the conntrack flush'), [
				E('span', {}, [
					_('With software or hardware flow offloading enabled in the firewall, established connections take a kernel fast path that skips netfilter, so they can survive a switchover even with the conntrack flush turned on. If you run offloading and want clean failover, expect to add a selective flush hook in /etc/mwan3.user.')
				])
			])
		]));
	},

	/* ------------------------------------------------------------ render */

	render: function(data) {
		var self = this,
		    mwan3Loaded = (data[1] !== null),
		    networks = data[2],
		    status = data[3],
		    events = data[4];

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

		var m = new form.Map('wansentry', _('WAN failover'),
			_('One primary uplink, one backup, and a health check that decides between them. Applying this screen generates a complete minimal mwan3 configuration. Both uplinks must already exist as working network interfaces; wansentry steers between them, it does not create them.'));

		m.readonly = blocked;

		var s = m.section(form.NamedSection, 'main', 'wansentry');
		var o;

		o = s.option(form.Flag, 'enabled', _('Enable failover'),
			_('Off: the generated mwan3 interfaces are written with tracking disabled and the mwan3 service is stopped and disabled, so this router routes exactly as it did before. On: mwan3 is enabled and started with the configuration below.'));
		o.rmempty = false;

		o = s.option(form.Flag, 'show_all_interfaces', _('Show every interface'),
			forceAll
				? _('Forced on: either fewer than two interfaces look like uplinks, or a saved selection is one this screen would not offer. Everything is listed so nothing you have already chosen can become unselectable.')
				: _('Off: only interfaces with their own route off this router are offered. On: every interface is listed, each labelled with why it is not normally offered. Classification uses protocol, device and gateway rather than the interface name, and it can be wrong: an ISP that delivers the uplink over a tunnel looks exactly like a VPN from here. Turn this on if your uplink is missing.'));
		o.rmempty = false;
		o.readonly = forceAll;

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

		o = s.option(form.ListValue, 'primary', _('Primary interface'),
			_('The uplink traffic uses whenever its health check passes.'));
		o.value('', _('-- please select --'));
		choices.forEach(function(c) { o.value(c[0], c[1]); });

		o = s.option(form.ListValue, 'backup', _('Backup interface'),
			_('Used only while the primary is down. It must be a working netifd interface with its own gateway. wansentry does not create interfaces, it only steers between them.'));
		o.value('', _('-- please select --'));
		choices.forEach(function(c) { o.value(c[0], c[1]); });

		o = s.option(form.DynamicList, 'track_ip', _('Health-check hosts'),
			_('Pinged through each uplink\'s own routing table. Use two hosts on different operators: the generated config marks an uplink up when any one of them answers, so a single ICMP-hostile target cannot cause a phantom outage.'));
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
			_('Consecutive failed checks before an uplink is declared offline. Interval × threshold is your worst-case detection time.'));
		o.datatype = 'range(1,100)';
		o.placeholder = '3';
		o.rmempty = false;

		o = s.option(form.Value, 'up', _('Recovery threshold'),
			_('Consecutive successful checks before an uplink is declared online again. Keep this higher than the failure threshold; flapping back onto a shaky primary is worse than staying on a working backup a little longer.'));
		o.datatype = 'range(1,100)';
		o.placeholder = '6';
		o.rmempty = false;

		o = s.option(form.Flag, 'failback', _('Return to primary when it recovers'),
			_('On: as soon as the primary passes its recovery threshold, traffic moves back to it. Off: sets mwan3 stickiness, an ipset keyed on source IP. A client that failed over keeps using the backup for up to 10 minutes after its last matching packet; other clients follow the policy back to the primary immediately. It is source-IP stickiness, not per-connection, and mwan3 cannot latch permanently onto the backup, so "off" softens the failback rather than preventing it.'));
		o.rmempty = false;

		o = s.option(form.Flag, 'flush_conntrack', _('Flush connection tracking on switchover'),
			_('Recommended. When an uplink changes state the kernel still holds conntrack entries pinned to the old gateway, and TCP treats the resulting ICMP unreachables as a soft error, so clients retransmit into a dead path for minutes instead of reconnecting. Flushing forces every connection to be re-established over the surviving uplink. The cost is that connections on the healthy uplink are dropped too, because mwan3\'s flush is global rather than per-uplink.'));
		o.rmempty = false;

		return m.render().then(function(mapNode) {
			self.map = m;
			self.statusNode = E('div', {}, self.renderStatus(status, events));

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

			return E([], [
				E([], self.renderBanners(mwan3Loaded, audit)),

				ws.card(_('Failover status'),
					_('refreshed every %d s').format(POLL_INTERVAL),
					self.statusNode),

				mapNode,

				ws.card(_('Generated mwan3 configuration'),
					_('written to /etc/config/mwan3 on apply'),
					self.previewNode),

				self.renderLimits()
			]);
		});
	},

	/* Build a raw {opt: value} map from the current widget values and normalise
	 * it the same way a uci read would be, so the preview matches exactly what a
	 * save would generate. */
	liveSettings: function() {
		var m = this.map;
		var fv = function(name) {
			var o = m && m.lookupOption ? m.lookupOption(name, 'main') : null;
			return (o && o[0]) ? o[0].formvalue('main') : null;
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
			flush_conntrack: fv('flush_conntrack')
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
		             'interval', 'down', 'up', 'failback', 'flush_conntrack' ];
		var update = function() { self.renderPreview(); };

		opts.forEach(function(name) {
			var o = m.lookupOption ? m.lookupOption(name, 'main') : null;
			var w = (o && o[0]) ? o[0].getUIElement('main') : null;
			var node = w && w.node ? w.node : null;

			if (node) {
				node.addEventListener('change', update);
				node.addEventListener('keyup', update);
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
