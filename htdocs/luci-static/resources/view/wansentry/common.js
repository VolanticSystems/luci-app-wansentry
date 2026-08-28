// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 VolanticSystems

'use strict';
'require baseclass';
'require rpc';
'require fs';

/*
 * wansentry, shared frontend helpers.
 *
 * Everything both the status panel and the settings form need that is not
 * mwan3 config generation: the ubus bindings, the log reader, the CSS and a
 * handful of small DOM primitives.
 *
 * Styling follows the same rule as the sibling appflow app: no colour probing,
 * no theme detection. Every colour is either a bootstrap CSS custom property
 * or a mid-luminance hue that stays legible on the light and the dark theme.
 */

/* ------------------------------------------------------------------ ubus */

/* `reject: true` so a non-zero ubus status rejects instead of resolving to
 * null: status 4 (object not found) means mwan3 is not installed or rpcd has
 * not picked up its ucode plugin, status 6 (permission denied) means an ACL
 * gap. The status panel keys its "no data" states off exactly those. */
var callMwan3Status = rpc.declare({
	object: 'mwan3',
	method: 'status',
	params: [ 'section', 'interface' ],
	reject: true
});

/* ------------------------------------------------------------------- css */

var STYLE_ID = 'wansentry-style';

var CSS = '\
.ws-card{border:1px solid var(--border-color-medium);border-radius:4px;\
 background:var(--background-color-high);padding:.8em 1em 1em;margin:0 0 1em}\
.ws-cardhead{display:flex;align-items:baseline;justify-content:space-between;\
 gap:.75em;flex-wrap:wrap;margin:0 0 .8em}\
.ws-cardhead h3{margin:0;padding:0;font-size:15px;font-weight:700;border:none}\
.ws-cardaux{font-size:11px;color:var(--text-color-medium)}\
.ws-sub{color:var(--text-color-medium);font-size:11px;line-height:15px;display:block}\
.ws-mono{font-family:var(--font-mono);font-size:11px}\
.ws-note{border-left:3px solid var(--border-color-medium);padding:.15em 0 .15em .8em;\
 margin:0 0 1em;font-size:12px;line-height:1.5}\
.ws-note h4{margin:0 0 .25em;font-size:12px;font-weight:700}\
.ws-note.ws-warn{border-left-color:hsl(27,70%,46%)}\
.ws-note.ws-error{border-left-color:hsl(2,62%,50%)}\
.ws-note.ws-info{border-left-color:hsl(210,58%,46%)}\
.ws-lanes{display:grid;grid-template-columns:1fr;gap:1em}\
@media (min-width:760px){.ws-lanes{grid-template-columns:1fr 1fr}}\
.ws-lane{border:1px solid var(--border-color-medium);border-radius:4px;padding:.7em .9em}\
.ws-lane.ws-active{border-color:hsl(150,50%,36%);box-shadow:inset 3px 0 0 hsl(150,50%,36%)}\
.ws-lanehead{display:flex;align-items:baseline;justify-content:space-between;gap:.6em}\
.ws-lanename{font-weight:700;font-size:13px}\
.ws-role{font-size:10px;text-transform:uppercase;letter-spacing:.06em;\
 color:var(--text-color-medium)}\
.ws-dot{display:inline-block;width:8px;height:8px;border-radius:50%;\
 margin-right:.45em;vertical-align:baseline;background:hsl(0,0%,55%)}\
.ws-dot.ws-up{background:hsl(150,50%,40%)}\
.ws-dot.ws-down{background:hsl(2,62%,52%)}\
.ws-dot.ws-idle{background:hsl(0,0%,55%)}\
.ws-kv{display:grid;grid-template-columns:auto 1fr;gap:.15em .8em;margin:.6em 0 0;\
 font-size:11.5px}\
.ws-kv dt{color:var(--text-color-medium);white-space:nowrap}\
.ws-kv dd{margin:0;font-variant-numeric:tabular-nums}\
.ws-hosts{margin:.6em 0 0;width:100%;font-size:11px;border-collapse:collapse}\
.ws-hosts td,.ws-hosts th{padding:.18em .5em .18em 0;text-align:left;\
 border-bottom:1px solid var(--border-color-low)}\
.ws-hosts th{color:var(--text-color-medium);font-weight:400}\
.ws-hosts .ws-num{text-align:right;font-variant-numeric:tabular-nums}\
.ws-events{margin:0;padding:0;list-style:none;font-size:11.5px;line-height:1.55}\
.ws-events li{display:flex;gap:.8em;padding:.15em 0;border-bottom:1px solid var(--border-color-low)}\
.ws-events li:last-child{border-bottom:none}\
.ws-events time{color:var(--text-color-medium);white-space:nowrap;\
 font-variant-numeric:tabular-nums}\
.ws-pre{margin:0;padding:.7em .9em;overflow-x:auto;border-radius:3px;\
 background:var(--background-color-low);border:1px solid var(--border-color-low);\
 font-family:var(--font-mono);font-size:11px;line-height:1.5;white-space:pre}\
';

function injectCSS() {
	if (document.getElementById(STYLE_ID))
		return;

	var style = E('style', { 'type': 'text/css', 'id': STYLE_ID }, [ CSS ]);
	document.head.appendChild(style);
}

/* ------------------------------------------------------------ formatting */

function duration(sec) {
	sec = parseInt(sec) || 0;

	if (sec <= 0)
		return '-';

	var d = Math.floor(sec / 86400),
	    h = Math.floor(sec % 86400 / 3600),
	    m = Math.floor(sec % 3600 / 60),
	    s = sec % 60;

	if (d) return '%dd %dh'.format(d, h);
	if (h) return '%dh %dm'.format(h, m);
	if (m) return '%dm %ds'.format(m, s);
	return '%ds'.format(s);
}

/* ------------------------------------------------------------------- dom */

function card(title, aux, content) {
	return E('div', { 'class': 'ws-card' }, [
		E('div', { 'class': 'ws-cardhead' }, [
			E('h3', {}, [ title ]),
			aux ? E('div', { 'class': 'ws-cardaux' }, [ aux ]) : ''
		]),
		content
	]);
}

/* kind: 'info' | 'warn' | 'error' */
function note(kind, title, body) {
	return E('div', { 'class': 'ws-note ws-' + kind }, [
		E('h4', {}, [ title ]),
		E('div', {}, Array.isArray(body) ? body : [ body ])
	]);
}

function dot(state) {
	return E('span', { 'class': 'ws-dot ws-' + state });
}

/* -------------------------------------------------------------- log tail */

/* mwan3 writes two line shapes we care about, both via `logger -t`:
 *   mwan3track[pid]: Interface wan (wan) is offline
 *   mwan3-hotplug[pid]: Execute ifdown event on interface wan (wan)
 * Everything else (rule/ipset chatter) is noise for a five-field UI, so the
 * parser keeps only online/offline transitions and reports the newest first.
 *
 * logread has no structured output and no ubus object, so this is the one
 * place the app shells out. `-l 200` bounds the cost: without it logread
 * returns the entire matching ring buffer every 5 s poll, which on a router
 * where mwan3 has been flapping is the whole log each tick. The ACL grants exec
 * on exactly this command string and nothing else. */
/* The leading fields are anchored by SHAPE -- syslog timestamp, then a
 * facility.level token -- rather than by a lazy `(.+?)\s+\S+\s+`. The lazy
 * form let the prefix absorb an entire real log line, so ANY process able to
 * write to syslog could put a fabricated failover event on this screen simply
 * by including the text in its own message:
 *
 *   ... daemon.warn dropbear[999]: mwan3track[1]: Interface wan (wan) is offline
 *
 * matched, and was rendered as a genuine wan outage. Raised by a security
 * audit. The panel is informational and drives no decision, so this is
 * integrity of what the operator is shown rather than a route to privilege,
 * but showing someone a failover that never happened is its own kind of
 * damage. Verified against real mwan3track lines, including the space-padded
 * single-digit day busybox emits. */
var EVENT_RE = /^(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+\S+\.\S+\s+(mwan3\S*)\[\d+\]:\s+Interface\s+(\S+)\s+\(([^)]*)\)\s+is\s+(online|offline)/;

function events(limit) {
	return fs.exec('/sbin/logread', [ '-l', '200', '-e', 'mwan3' ]).then(function(res) {
		if (!res || res.code !== 0 || !res.stdout)
			return [];

		var out = [];

		res.stdout.split(/\n/).forEach(function(line) {
			var m = EVENT_RE.exec(line);

			if (m)
				out.push({ time: m[1], iface: m[3], device: m[4], state: m[5] });
		});

		return out.reverse().slice(0, limit || 8);
	}).catch(function() {
		/* ACL gap or no logread: the panel renders an explanatory empty
		 * state rather than a broken card. */
		return null;
	});
}

return baseclass.extend({
	rpc: {
		status: callMwan3Status
	},

	injectCSS: injectCSS,
	duration: duration,
	card: card,
	note: note,
	dot: dot,
	events: events
});
