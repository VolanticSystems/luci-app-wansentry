#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 VolanticSystems
//
// wansentry browser-half suite: the ownership contract, in the browser.
//
// WHY THIS FILE EXISTS. The ownership rule is implemented TWICE, in audit() /
// isOwned() here and in the owned/managed/foreign arithmetic in
// root/etc/init.d/wansentry. DESIGN 6.3 says the two must agree, and the
// package's whole safety promise rests on it: the generator refuses to WRITE
// mwan3 config it did not create, and the service must refuse just as hard or
// it stops a stranger's mwan3 at boot, because enabled=0 is the shipped
// default.
//
// That rule has drifted THREE times, and all three times the drift pointed the
// same way: at tearing down configuration this package did not write. Until
// now only the router half was tested. tests/ownership-suite.sh drives the
// real init script on hardware; nothing drove this half at all, so "the two
// agree" was a claim checked by reading.
//
//   usage:  node tests/generator-suite.js
//
// Runs anywhere Node runs. No router, no browser, no network.
//
// THE FIXTURES ARE WRITTEN AS `uci show mwan3` OUTPUT ON PURPOSE. That is the
// exact text the init script parses, so both halves are described once, in one
// notation. Describing the same configuration twice in two notations is how
// they stopped agreeing in the first place.
//
// SABOTAGE COMMENTS: every check names the smallest edit to the PRODUCT that
// turns it red, written before the assertion. See tests/ownership-suite.sh for
// why that ordering is the discipline rather than a house style.

'use strict';

const path = require('path');
const { load, uciStub, parseUciShow, potMsgids } = require('./luci-module.js');

const ROOT = path.join(__dirname, '..');
const GEN = path.join(ROOT, 'htdocs/luci-static/resources/view/wansentry/generator.js');
const POT = path.join(ROOT, 'po/templates/wansentry.pot');

let PASS = 0, FAIL = 0;

// Every module instance this run loads. The catalogue check at the bottom
// harvests their _() call logs AT THE END, not as they are loaded.
//
// The first version copied gen.__translated at load time and reported "all 0
// strings reached by this run are in the catalogue". generator.js calls _()
// only from inside validate() and friends, so nothing had been recorded yet
// and the check passed against an empty set: a tautology of exactly the kind
// this suite exists to avoid, in the check that was supposed to catch a
// rotting catalogue.
const loaded = [];

function ok(m)  { PASS++; console.log('  PASS  ' + m); }
function bad(m) { FAIL++; console.log('  FAIL  ' + m); }
function chk(desc, expected, actual) {
	const e = JSON.stringify(expected), a = JSON.stringify(actual);
	if (e === a) ok(desc); else bad(`${desc} (expected ${e}, got ${a})`);
}
function head(m) { console.log('\n=== ' + m + ' ==='); }

// Load the real module against one fixture and return audit()'s answer.
function auditOf(uciShowText) {
	const secs = parseUciShow(uciShowText);
	const gen = load(GEN, { uci: uciStub({ mwan3: secs, wansentry: [] }) });
	loaded.push(gen);
	return { gen: gen, audit: gen.audit(), sections: secs };
}

const GLOBALS = "mwan3.globals=globals\nmwan3.globals.mmx_mask='0x3F00'\n";

// ------------------------------------------------------------ the contract

head('THE OWNERSHIP CONTRACT, as the browser reads it');

// Each case states what the ROUTER computes and what the BROWSER must
// therefore say, so a divergence shows up as a failure here rather than as a
// surprise on somebody's router.
//
// `foreign` non-empty in the browser must correspond to `foreign > 0` on the
// router, which is the condition that makes the init script hand off.
const CASES = [
	{
		name: 'globals only (rolled-back first enable)',
		uci: GLOBALS,
		owned: 0, stock: 0, foreign: 0,
		why: 'globals belongs to neither side; router computes managed=0 owned=0'
	},
	{
		name: 'an unknown section type with an ordinary name',
		uci: GLOBALS + "mwan3.mynotify=notify\nmwan3.mynotify.enabled='1'\n",
		owned: 0, stock: 0, foreign: 1,
		why: 'type outside MANAGED_TYPES is foreign before isOwned() is consulted'
	},
	{
		// THE DIVERGENCE. This is the case that was broken on the router until
		// 2026-08-26: `owned` matched the wansentry_ namespace on NAME alone,
		// with no test of type, so it read owned=1 managed=1 foreign=0, did not
		// hand off, and with the shipped enabled=0 stopped and disabled a
		// stranger's mwan3.
		//
		// SABOTAGE: in generator.js audit(), move the `MANAGED_TYPES.indexOf`
		// test below the isOwned() test. The browser then agrees with the OLD
		// router behaviour, calls this owned, and this check goes red.
		name: 'an unknown section type NAMED wansentry_*',
		uci: GLOBALS + "mwan3.wansentry_notify=notify\nmwan3.wansentry_notify.enabled='1'\n",
		owned: 0, stock: 0, foreign: 1,
		why: 'the namespace must not override the type gate; this is the 2026-08-26 divergence'
	},
	{
		// SABOTAGE: in isOwned(), change `sec[OWNER_OPT] === '1'` to
		// `sec[OWNER_OPT] != null`. Not this case, but the near-miss cases
		// below, go red.
		name: 'a managed type carrying the marker option',
		uci: GLOBALS + "mwan3.some_iface=interface\nmwan3.some_iface.enabled='1'\nmwan3.some_iface.wansentry='1'\n",
		owned: 1, stock: 0, foreign: 0,
		why: 'marker + managed type is ours; router tears down when enabled=0'
	},
	{
		name: 'a managed type in the wansentry_ namespace, no marker option',
		uci: GLOBALS + "mwan3.wansentry_primary=member\nmwan3.wansentry_primary.interface='wan'\n",
		owned: 1, stock: 0, foreign: 0,
		why: 'namespace alone claims it, provided the type is managed'
	},
	{
		name: 'a doubly-marked section plus one foreign interface',
		uci: GLOBALS +
		     "mwan3.wansentry_both=interface\nmwan3.wansentry_both.enabled='1'\nmwan3.wansentry_both.wansentry='1'\n" +
		     "mwan3.a_stranger=interface\nmwan3.a_stranger.enabled='1'\n",
		owned: 1, stock: 0, foreign: 1,
		why: 'the doubly-marked one must be counted ONCE; the router dedups with sort -u'
	}
];

for (const c of CASES) {
	const r = auditOf(c.uci);
	chk(`${c.name}: owned`,   c.owned,   r.audit.owned.length);
	chk(`${c.name}: foreign`, c.foreign, r.audit.foreign.length);
}

head('MARKER VALUES: only the value the generator writes counts');

// Mirror of the `values` group in tests/ownership-suite.sh. Same four
// near-misses, asserted against the other implementation.
//
// SABOTAGE: in isOwned(), relax `sec[OWNER_OPT] === '1'` to a truthiness or
// `!= null` test. All four go red at once, and so does the shell suite's
// matching group, which is the point of running both.
for (const v of ['0', 'true', 'yes', '11']) {
	const r = auditOf(GLOBALS +
		`mwan3.near_miss=interface\nmwan3.near_miss.enabled='1'\nmwan3.near_miss.wansentry='${v}'\n`);
	chk(`marker value '${v}' does not confer ownership`, 1, r.audit.foreign.length);
}

head('SCALE: the classification holds on a config far larger than expected');

// Mirror of the robustness group. 300 foreign, then 300 owned.
//
// SABOTAGE: add an early `if (i > 20) return;`-style bound to audit()'s
// forEach. The counts stop matching and both checks go red.
let bulk = GLOBALS;
for (let i = 1; i <= 300; i++)
	bulk += `mwan3.bulk${i}=interface\nmwan3.bulk${i}.enabled='1'\n`;
chk('300 foreign sections are all classified foreign', 300, auditOf(bulk).audit.foreign.length);

let owned = GLOBALS;
for (let i = 1; i <= 300; i++)
	owned += `mwan3.wansentry_bulk${i}=interface\nmwan3.wansentry_bulk${i}.enabled='1'\n`;
const ownedAudit = auditOf(owned).audit;
chk('300 owned sections are all classified owned', 300, ownedAudit.owned.length);
chk('and none of them is foreign', 0, ownedAudit.foreign.length);

// ------------------------------------------------------------- generation

head('WHAT desired() GENERATES');

const g = auditOf(GLOBALS).gen;
const s = g.normalize({
	enabled: '1', primary: 'wan', backup: 'wwan',
	track_ip: '1.1.1.1 8.8.8.8', interval: '5', down: '3', up: '6',
	failback: '1', flush_conntrack: '1'
});
const want = g.desired(s);

// desired() returns an ARRAY of { name, type, options } records, one per
// section, in write order. An earlier version of this file assumed a
// name-keyed object and compared against Object.keys(), which produced
// ["0","1","2",...] and read as a generation defect. It was the test guessing
// at a shape instead of reading one.
const names = want.map((x) => x.name).sort();
const types = want.map((x) => x.type);

// DESIGN 6.1: two interfaces, two members, one policy, one rule. Not one
// section more. That count is the claim the README makes to a reader deciding
// whether to trust this with their mwan3.
//
// SABOTAGE: add any extra section to desired(). Both checks go red, and they
// should: "and not one section more" stops being true the moment it silently
// does.
chk('desired() writes exactly six sections', 6, want.length);
chk('and they are the documented six',
    ['wan', 'wansentry_backup', 'wansentry_def', 'wansentry_fail',
     'wansentry_primary', 'wwan'],
    names);
chk('in the documented order and types',
    ['interface', 'interface', 'member', 'member', 'policy', 'rule'],
    types);

// SABOTAGE: drop the OWNER_OPT assignment from any generated section. That
// section becomes foreign to BOTH halves on the next audit, the form goes
// read-only, and the package can no longer manage what it wrote. This is the
// single most consequential line in desired().
const unmarked = want.filter((x) => x.options[g.OWNER_OPT] !== '1')
                     .map((x) => x.name);
chk('every generated section carries the ownership marker', [], unmarked);

// The mirror of the contract group: feed desired()'s own output back through
// audit() and every section must come back OWNED. If these two ever disagree
// the package generates configuration it will then refuse to manage, which is
// a deadlock the user cannot get out of from the UI.
//
// SABOTAGE: either the OWNER_OPT drop above, or moving the type gate in
// audit(). This is the check that ties the generator to the classifier.
const asSections = want.map((x) =>
	Object.assign({ '.name': x.name, '.type': x.type }, x.options));
const genB = load(GEN, { uci: uciStub({ mwan3: asSections, wansentry: [] }) });
loaded.push(genB);
const back = genB.audit();
chk('audit() classifies everything desired() writes as owned', 6, back.owned.length);
chk('and none of it as foreign', 0, back.foreign.length);

// SABOTAGE: change `last_resort` in the policy from 'default' to
// 'unreachable'. That option is what keeps traffic falling through to the
// kernel routing table when both uplinks are down instead of being
// blackholed, and mwan3_armed() on the router depends on the policy still
// being installed in that state during a dual outage.
const policy = want.find((x) => x.name === g.POLICY);
chk('the policy sets last_resort=default', 'default', policy.options.last_resort);

head('VALIDATION refuses what it should');

// SABOTAGE: delete any one guard from validate(). Its row goes red.
// Each returns a message string on rejection and null on acceptance.
const BAD = [
	['no interfaces chosen',      { primary: '',    backup: ''     }],
	['primary equals backup',     { primary: 'wan', backup: 'wan'  }],
	['a reserved wansentry_ name',{ primary: 'wansentry_primary', backup: 'wan' }]
];
for (const [desc, partial] of BAD) {
	const cand = g.normalize(Object.assign(
		{ track_ip: '1.1.1.1', interval: '5', down: '3', up: '6' }, partial));
	const msg = g.validate(cand);
	if (typeof msg === 'string' && msg.length) ok(`validate() rejects ${desc}`);
	else bad(`validate() ACCEPTED ${desc} (returned ${JSON.stringify(msg)})`);
}

// The mirror. A guard that rejects everything would pass every row above.
//
// SABOTAGE: make validate() return a message unconditionally. This goes red
// while all three rows above stay green, which is why it is here.
const good = g.normalize({
	primary: 'wan', backup: 'wwan', track_ip: '1.1.1.1',
	interval: '5', down: '3', up: '6'
});
chk('validate() accepts a well-formed setting', null, g.validate(good) ?? null);

// ------------------------------------------------------------- catalogue

head('THE STRING CATALOGUE COVERS WHAT THE CODE ASKS FOR');

// Every string _() was called with during this whole run must be in the .pot.
//
// SABOTAGE: add a `_('some new string')` anywhere in generator.js without
// regenerating po/templates/wansentry.pot. This goes red. Without it, the
// catalogue silently rots the moment anyone adds a message, and nobody finds
// out until a translator does.
const pot = potMsgids(POT);
const seen = new Set();
for (const m of loaded) for (const t of m.__translated) if (t) seen.add(t);

// A catalogue check over an empty set is not a check. Refuse to report a pass
// unless the run actually reached some strings, and say how many.
if (seen.size === 0) {
	bad('the run reached NO _() strings, so the catalogue check proved nothing');
} else {
	const missing = [...seen].filter((x) => !pot.has(x));
	if (missing.length === 0)
		ok(`all ${seen.size} strings reached by this run are in the catalogue`);
	else
		bad(`${missing.length} of ${seen.size} string(s) not in wansentry.pot: `
		    + JSON.stringify(missing.slice(0, 5)));
}

console.log('\n----------------------------------------');
console.log(`passed ${PASS}, failed ${FAIL}`);
process.exit(FAIL);
