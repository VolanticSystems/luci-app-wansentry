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

// ------------------------------------------------------- pbr coexistence

head('PBR COEXISTENCE: mwan3 must not override policy-based routing');

// WHY THIS GROUP EXISTS, measured rather than assumed.
//
// pbr and mwan3 both mark packets and both install ip rules. The marks do NOT
// collide (pbr 0x00ff0000, mwan3 0x00003f00). What collides is ip rule
// PRIORITY: mwan3 sits at 1001-3002 and pbr at 29995-30000, and evaluation is
// ascending, so mwan3 is consulted ~28000 priorities first and pbr's policy
// never runs.
//
// Bench, 2026-08-27, real forwarded traffic with the conntrack reply tuple
// naming the uplink that SNAT-ed:
//
//   no exclusion   client inside a pbr policy range -> plain WAN     WRONG
//   exclusion      same client                      -> the tunnel    RIGHT
//
// Neither package logs anything either way, which is what makes it worth a
// test rather than a paragraph in the README.

// Load the generator against BOTH an mwan3 and a pbr fixture.
function genPbr(pbrText, mwan3Text) {
	const gen = load(GEN, {
		uci: uciStub({
			mwan3: parseUciShow(mwan3Text || GLOBALS),
			pbr: parseUciShow(pbrText || ''),
			wansentry: []
		})
	});
	loaded.push(gen);
	return gen;
}

const PBR_ON = "pbr.config=pbr\npbr.config.enabled='1'\n";

// A faithful copy of the reference production policy set, in `uci show pbr`
// notation for the same reason the mwan3 fixtures are: one notation, described
// once.
const PBR_REAL = PBR_ON +
	"pbr.p0=policy\npbr.p0.name='Local_DMZ_Access'\n" +
	"pbr.p0.src_addr='192.168.72.128/25'\npbr.p0.dest_addr='192.168.178.0/24'\n" +
	"pbr.p0.interface='wan'\n" +
	"pbr.p1=policy\npbr.p1.name='Send2USA'\n" +
	"pbr.p1.src_addr='192.168.72.128/25'\npbr.p1.interface='vpnusa'\n" +
	"pbr.p2=policy\npbr.p2.name='Dante_Egress'\n" +
	"pbr.p2.src_addr='192.168.72.6'\npbr.p2.interface='vpnusa'\n" +
	"pbr.p2.chain='output'\n";

const mkSettings = (gen) => gen.normalize({
	enabled: '1', primary: 'wan', backup: 'wwan',
	track_ip: '1.1.1.1 8.8.8.8', interval: '5', down: '3', up: '6',
	failback: '1', flush_conntrack: '1'
});

// THE CLEAN-DEGRADATION CASE. Most routers do not run pbr and must be entirely
// unaffected, including producing byte-identical mwan3 config.
//
// SABOTAGE: drop the early return in pbrClaims() that fires when neither a pbr
// globals nor a pbr policy section exists. Undefined options then flow through
// and this goes red, along with the six-section count above.
{
	const gen = genPbr('');
	chk('pbr absent: no exclusion rules', 0, gen.pbrRules().length);
	chk('pbr absent: desired() still writes exactly six sections',
	    6, gen.desired(mkSettings(gen)).length);
}

// pbr installed but switched off installs no ip rules, so there is nothing to
// be overridden and an exclusion would be noise in someone's config file.
//
// SABOTAGE: delete the `globals.enabled === '0'` guard in pbrClaims().
{
	const gen = genPbr("pbr.config=pbr\npbr.config.enabled='0'\n" +
		"pbr.p0=policy\npbr.p0.name='X'\npbr.p0.src_addr='10.0.0.0/8'\n");
	chk('pbr disabled: no exclusion rules', 0, gen.pbrRules().length);
}

// A single policy disabled inside an enabled pbr.
//
// SABOTAGE: delete the per-policy `p.enabled === '0'` guard.
{
	const gen = genPbr(PBR_ON +
		"pbr.p0=policy\npbr.p0.name='Off'\npbr.p0.src_addr='10.0.0.0/8'\n" +
		"pbr.p0.enabled='0'\n");
	chk('a disabled policy is not excluded', 0, gen.pbrRules().length);
}

// THE REAL CONFIG. Three policies, three exclusions.
{
	const gen = genPbr(PBR_REAL);
	const rules = gen.pbrRules();

	chk('the reference pbr config yields three exclusions', 3, rules.length);

	// Every generated section must carry the ownership marker, or audit() will
	// call wansentry's own output foreign and the generator will then refuse to
	// apply its own configuration on the second run.
	//
	// SABOTAGE: remove `o[OWNER_OPT] = '1'` from pbrRules().
	chk('every exclusion carries the ownership marker',
	    true, rules.every((r) => r.options[gen.OWNER_OPT] === '1'));

	// use_policy 'default' is the whole mechanism: it stamps mwan3's no-op mark
	// 0x3f00, which matches none of mwan3's own ip rules, so evaluation falls
	// through to pbr's at 29996.
	//
	// SABOTAGE: change 'default' to the failover policy name. The rule then
	// steers the traffic instead of standing aside, which is the defect this
	// whole group exists to prevent, and it goes red.
	chk('every exclusion uses mwan3 use_policy=default',
	    true, rules.every((r) => r.options.use_policy === 'default'));

	// mwan3 truncates rule names at 15 characters when it builds chain names
	// and silently skips anything longer, so an over-long name is a rule that
	// does not exist.
	//
	// SABOTAGE: lengthen PBR_PREFIX by three characters.
	chk('no exclusion name exceeds mwan3 15-character limit',
	    true, rules.every((r) => r.name.length <= 15));

	// Both of the reference policies that name a source must be represented.
	const srcs = rules.map((r) => r.options.src_ip).sort();
	chk('the source ranges pbr claims are the ones excluded',
	    ['192.168.72.128/25', '192.168.72.128/25', '192.168.72.6'], srcs);

	// The dest-bearing policy must keep its destination, or the exclusion is
	// broader than the policy it protects and would stand mwan3 down for
	// traffic pbr never claimed.
	//
	// SABOTAGE: stop copying dest_addr in pbrClaims().
	chk('a policy with a destination keeps it', 1,
	    rules.filter((r) => r.options.dest_ip === '192.168.178.0/24').length);
}

// ORDER IS LOAD-BEARING. mwan3 evaluates rules in file order and stops at the
// first match, so an exclusion behind the catch-all can never fire. This is the
// check that would have caught the uci.add-appends problem.
//
// SABOTAGE: in desired(), concat pbrRules() AFTER the catch-all instead of
// before it. Everything else still passes; only this goes red.
{
	const gen = genPbr(PBR_REAL);
	const want = gen.desired(mkSettings(gen));
	const order = want.map((x) => x.name);
	const catchAll = order.indexOf(gen.RULE);
	const excl = order.map((n, i) => n.indexOf(gen.PBR_PREFIX) === 0 ? i : -1)
	                  .filter((i) => i >= 0);

	chk('desired() places every exclusion before the catch-all rule',
	    true, excl.length === 3 && excl.every((i) => i < catchAll));
	chk('the catch-all is still the last section', want.length - 1, catchAll);
}

// A policy that names neither source nor destination claims ALL traffic. An
// mwan3 rule mirroring it would match every packet on the router, including the
// tunnel's own outer packets, and switch failover off while appearing to
// configure it. It must be refused and reported, never approximated.
//
// SABOTAGE: delete the `!src.length && !dst.length` branch in pbrClaims() so it
// falls through and emits a rule with no match criteria. Both go red.
{
	const gen = genPbr(PBR_ON +
		"pbr.p0=policy\npbr.p0.name='CatchAll'\npbr.p0.interface='vpnusa'\n");
	const c = gen.pbrClaims();

	chk('a policy claiming everything produces no exclusion', 0, c.claims.length);
	chk('and is reported as skipped rather than dropped silently',
	    ['CatchAll'], c.skipped);
}

// pbr accepts several addresses in one option; mwan3 rules take one each.
//
// SABOTAGE: replace splitAddrs() with a pass-through. The count drops to 1 and
// the address becomes the whole space-separated blob, which mwan3 would reject.
{
	const gen = genPbr(PBR_ON +
		"pbr.p0=policy\npbr.p0.name='Multi'\n" +
		"pbr.p0.src_addr='10.1.0.0/16 10.2.0.0/16, 10.3.0.0/16'\n");
	const rules = gen.pbrRules();

	chk('three addresses in one policy yield three exclusions', 3, rules.length);
	chk('and each carries exactly one address',
	    ['10.1.0.0/16', '10.2.0.0/16', '10.3.0.0/16'],
	    rules.map((r) => r.options.src_ip).sort());
}

// mwan3 rejects a port match with no protocol, and pbr allows one. Carrying the
// port anyway would generate a config mwan3 refuses to load, taking failover
// down completely rather than partially.
//
// SABOTAGE: drop the `ports` guard and copy src_port/dest_port unconditionally.
{
	const gen = genPbr(PBR_ON +
		"pbr.p0=policy\npbr.p0.name='NoProto'\n" +
		"pbr.p0.src_addr='10.0.0.0/8'\npbr.p0.dest_port='443'\n");
	const o = gen.pbrRules()[0].options;

	chk('a port without a protocol is dropped, not copied', undefined, o.dest_port);

	const gen2 = genPbr(PBR_ON +
		"pbr.p0=policy\npbr.p0.name='WithProto'\n" +
		"pbr.p0.src_addr='10.0.0.0/8'\npbr.p0.proto='tcp'\n" +
		"pbr.p0.dest_port='443'\n");
	const o2 = gen2.pbrRules()[0].options;

	chk('a port WITH a protocol is carried', '443', o2.dest_port);
	chk('and so is the protocol', 'tcp', o2.proto);
}

// Determinism. An unstable order would rewrite /etc/config/mwan3 on every
// apply, which breaks the package's idempotency claim and churns a file people
// keep in version control.
//
// SABOTAGE: remove the claims.sort() in pbrClaims().
//
// The first version of this check loaded the SAME fixture twice and compared
// the two results. That passes with or without the sort, because the same input
// in the same order produces the same output either way: a tautology sitting in
// the check meant to catch non-determinism. What the sort actually buys is that
// the ORDER OF SECTIONS IN /etc/config/pbr does not change wansentry's output,
// so reordering the fixture is the only thing that tests it.
{
	const REVERSED = PBR_ON +
		"pbr.p2=policy\npbr.p2.name='Dante_Egress'\n" +
		"pbr.p2.src_addr='192.168.72.6'\npbr.p2.interface='vpnusa'\n" +
		"pbr.p2.chain='output'\n" +
		"pbr.p1=policy\npbr.p1.name='Send2USA'\n" +
		"pbr.p1.src_addr='192.168.72.128/25'\npbr.p1.interface='vpnusa'\n" +
		"pbr.p0=policy\npbr.p0.name='Local_DMZ_Access'\n" +
		"pbr.p0.src_addr='192.168.72.128/25'\npbr.p0.dest_addr='192.168.178.0/24'\n" +
		"pbr.p0.interface='wan'\n";

	const opts = (t) => genPbr(t).pbrRules().map(function(r) {
		const o = r.options;

		return [ o.src_ip, o.dest_ip, o.proto ].join('|');
	});

	chk('reordering /etc/config/pbr does not change the exclusions',
	    opts(PBR_REAL), opts(REVERSED));
}

// The generator must not classify its own exclusions as foreign, or the second
// apply refuses with "mwan3 contains configuration wansentry did not create".
//
// THE FIXTURE IS BUILT FROM THE NAMES THE GENERATOR ACTUALLY PRODUCES. The
// first version of this check hardcoded 'wansentry_pbr1'/'wansentry_pbr2' in
// the mwan3 fixture, so changing PBR_PREFIX could not reach it: the sabotage
// this comment claimed to catch left the check green. Running the sabotage is
// what found that; reading the check did not.
{
	const names = genPbr(PBR_REAL).pbrRules().map((r) => r.name);

	let fixture = GLOBALS;
	names.forEach((n) => {
		fixture += `mwan3.${n}=rule\nmwan3.${n}.wansentry='1'\n`;
	});

	const a = genPbr(PBR_REAL, fixture).audit();

	chk('generated exclusions audit as owned, not foreign', 0, a.foreign.length);
	chk('and are counted as owned', names.length, a.owned.length);
}

// Ownership is deliberately belt-and-braces: a section is ours if it carries
// the marker OR sits in the wansentry_ namespace. The exclusions must satisfy
// BOTH, because the two halves of the contract lean on different ones — the
// generator reads the marker, and the init script's `claimed` arithmetic also
// matches the namespace by name.
//
// SABOTAGE: change PBR_PREFIX to anything not starting with 'wansentry_'. The
// audit above still passes, because the marker alone is enough for the browser
// half; only this goes red, which is exactly the divergence it exists to catch.
{
	const gen = genPbr(PBR_REAL);
	const rules = gen.pbrRules();

	chk('every exclusion name is inside the wansentry_ namespace',
	    true, rules.length > 0 && rules.every((r) => /^wansentry_/.test(r.name)));
}

head('TRACK OPTIONS: the opinions that are not mwan3 defaults');

// initial_state is deliberately 'offline', against mwan3's own default of
// 'online'. Measured on the bench 2026-08-28 with the modem-reboot scenario:
// link returns before the service behind it does.
//
//   online   -> mwan3 assumes the returning uplink is good, moves traffic back
//               to an uplink that cannot carry it, client BROKEN for ~9 s
//   offline  -> stays on the backup until probes prove the primary, no outage
//
// A cable pull does NOT expose this, because the link and the internet come
// back together. That is why the live cable-pull test passed and this still
// needed finding.
//
// SABOTAGE: set initial_state back to 'online' in trackOptions(). This goes red
// and nothing else does, which is the point: no other check in this suite
// notices, and neither did a real failover test on real hardware.
{
	const gen = genPbr('');
	const want = gen.desired(mkSettings(gen));
	const ifaces = want.filter((x) => x.type === 'interface');

	chk('both uplink sections are generated', 2, ifaces.length);
	chk('initial_state is offline on every uplink, not mwan3 default online',
	    true, ifaces.length > 0 && ifaces.every((i) => i.options.initial_state === 'offline'));

	// The reason offline is safe rather than merely cautious: the policy falls
	// through to the main routing table until an uplink proves itself. Without
	// last_resort default, offline would mean no route at all after a reboot.
	//
	// SABOTAGE: change last_resort to 'blackhole' or drop it. This goes red,
	// and it should, because it invalidates the argument for offline.
	const pol = want.filter((x) => x.type === 'policy')[0];
	chk('last_resort default is what makes initial_state offline safe',
	    'default', pol && pol.options.last_resort);
}

const clsGen = genPbr('');

head('INTERFACE CLASSIFIER: roles, labels, and the restricted-ACL case');

// WHY THIS GROUP EXISTS. The classifier decides which interfaces a user may
// pick as an uplink, and until now it was the only significant logic in this
// package with no automated test. It was checked by looking at it in a browser,
// as root, and a real bug survived that:
//
//   loaded as a genuinely RESTRICTED user, getProtocol() returns empty for
//   every interface, because this package deliberately does not grant uci read
//   on `network` (PPPoE passwords and WireGuard private keys live there). Every
//   label lost its protocol and device, and the filter meant to hide IPv6-only
//   interfaces failed OPEN and offered wan6 as a candidate uplink.
//
// A comment in the source asserted this could not happen, on the grounds that
// LuCI falls back to the netifd dump. It said "verified on hardware", and it
// had been, as root, where the fallback is never exercised.
//
// So these fixtures model BOTH sessions. `full` has uci data; `restricted` has
// only what netifd exposes through _ubus(), which is what the ACL grants.

// A fake LuCI Network object. Only the accessors the classifier uses.
//   uciProto/uciDev  what getProtocol()/getDevice() return (empty when the
//                    session may not read /etc/config/network)
//   ubus             what _ubus(key) returns, i.e. netifd's own view
function iface(name, opts) {
	const o = opts || {};
	return {
		getName: () => name,
		getProtocol: () => o.uciProto || '',
		getDevice: () => (o.uciDev ? { getName: () => o.uciDev } : null),
		isUp: () => !!o.up,
		getGatewayAddr: () => o.gw || null,
		_ubus: (k) => (o.ubus || {})[k] ?? null
	};
}

// The reference router, as a RESTRICTED session sees it: netifd only.
const RESTRICTED = [
	iface('lan',    { up: true,  ubus: { proto: 'static',    device: 'br-lan' } }),
	iface('wan',    { up: true,  gw: '192.168.1.1',
	                  ubus: { proto: 'dhcp',      device: 'eth1' } }),
	iface('wan6',   { up: false, ubus: { proto: 'dhcpv6',    device: 'eth1' } }),
	iface('wanb',   { up: false, ubus: { proto: 'dhcp',      device: 'eth2' } }),
	iface('vpnusa', { up: true,  gw: '10.38.0.1',
	                  ubus: { proto: 'none',      device: 'tun0' } }),
	iface('wwan',   { up: true,  gw: '192.168.178.1',
	                  ubus: { proto: 'dhcp',      device: 'phy1-sta0' } })
];

// The same router as ROOT sees it: uci data present as well.
const FULL = RESTRICTED.map((n) => n);   // superset behaviour asserted below

const clsRoles = (r) => r.all.reduce((m, c) => (m[c.name] = c.role, m), {});
const clsNames = (r) => r.choices.map((c) => c[0]);

// THE BUG, asserted directly. wan6 is dhcpv6 and must never be offered.
//
// SABOTAGE: in generator.js ifProto(), drop the _ubus() half and return only
// n.getProtocol(). wan6 reappears in the list and this goes red. That is the
// exact defect, and no other check in this suite notices it.
{
	const r = clsGen.classify(RESTRICTED, [ '', '' ], true);

	chk('an IPv6-only interface is never offered, even with no uci access',
	    false, clsNames(r).indexOf('wan6') >= 0);
	chk('and it is absent from the classification entirely',
	    undefined, clsRoles(r).wan6);
}

// Roles, from evidence rather than names.
//
// SABOTAGE: remove the tun/tap/wg device test in roleOf(). vpnusa is `proto
// none` over tun0, so the protocol test alone cannot catch it, and it becomes
// an offered uplink.
{
	const r = clsGen.classify(RESTRICTED, [ '', '' ], true);
	const R = clsRoles(r);

	chk('a plain uplink with a gateway is an uplink', 'uplink', R.wan);
	chk('a second one likewise',                      'uplink', R.wwan);
	chk('a tun device is a tunnel however it is configured', 'tunnel', R.vpnusa);
	chk('a bridge with no gateway is local',          'local',  R.lan);
	chk('an interface never seen up is unknown',      'unknown', R.wanb);
}

// Eligibility. `unknown` is offered ON PURPOSE: it is the LTE stick that is not
// plugged in, and hiding it would make the classifier's mistakes into the
// user's dead end.
//
// SABOTAGE: drop 'unknown' from the eligible filter. wanb disappears and this
// goes red.
{
	const r = clsGen.classify(RESTRICTED, [ '', '' ], false);

	chk('only uplinks and unknowns are offered by default',
	    [ 'wan', 'wanb', 'wwan' ], clsNames(r).sort());
	chk('a tunnel is not offered', false, clsNames(r).indexOf('vpnusa') >= 0);
	chk('a local network is not offered', false, clsNames(r).indexOf('lan') >= 0);
}

// THE LABELS. Protocol and device are what let someone with six interfaces pick
// the right one, and they are exactly what was lost on a restricted session.
//
// SABOTAGE: drop the _ubus() half of ifDevice(). The device disappears from
// every label and this goes red.
{
	const r = clsGen.classify(RESTRICTED, [ '', '' ], true);
	const byName = r.all.reduce((m, c) => (m[c.name] = c.label, m), {});

	chk('a label carries name, protocol, device and state',
	    'wan: dhcp, eth1, up', byName.wan);
	chk('an ineligible interface says why',
	    'vpnusa: none, tun0, up [VPN tunnel: runs over an uplink, cannot be one]',
	    byName.vpnusa);
	chk('a down interface reads down', true, /, down\b/.test(byName.wanb));
}

// A label must never render a dangling separator because one input was
// unavailable. This is the "wan: , wan, up" defect, found on a live router.
//
// SABOTAGE: remove the .filter() that drops empty parts in classify().
{
	const r = clsGen.classify([ iface('bare', { up: true, gw: '1.1.1.1' }) ], [ '', '' ], true);

	chk('an interface with no protocol or device still labels cleanly',
	    'bare: up', r.all[0].label);
}

// A SAVED SELECTION MUST NEVER BECOME UNSELECTABLE. Narrowing the list out from
// under a stored value would blank the field on the next save.
//
// SABOTAGE: remove the `picked.indexOf(...)` clause from forceAll.
{
	const r = clsGen.classify(RESTRICTED, [ 'vpnusa', 'wan' ], false);

	chk('choosing an ineligible interface forces the full list', true, r.forceAll);
	chk('and that selection is still offered', true, clsNames(r).indexOf('vpnusa') >= 0);
}

// Fewer than two plausible uplinks also forces the full list, so a user is
// never left with nothing to pick.
//
// SABOTAGE: remove the `eligible.length < 2` clause.
{
	const r = clsGen.classify([ RESTRICTED[0], RESTRICTED[1], RESTRICTED[4] ], [ '', '' ], false);

	chk('one eligible interface forces the full list', true, r.forceAll);
	chk('so the user still sees something to choose', true, r.choices.length > 1);
}

// Graceful degradation: no netifd data AND no uci data. Everything is unknown,
// nothing is wrongly excluded, and the screen still offers a choice.
//
// SABOTAGE: make ifProto() throw on a missing _ubus rather than guarding with
// typeof. This group throws instead of failing, which is louder still.
{
	const bare = [ iface('a', {}), iface('b', {}) ];
	const r = clsGen.classify(bare, [ '', '' ], false);

	chk('with no data at all, both are unknown rather than excluded',
	    [ 'unknown', 'unknown' ], r.all.map((c) => c.role));
	chk('and both remain choosable', [ 'a', 'b' ], clsNames(r).sort());
}

// uci data is used when netifd has none, so a router where the session CAN read
// /etc/config/network behaves exactly as before.
//
// SABOTAGE: reverse the precedence in ifProto() so uci wins over netifd. This
// stays green, but the restricted-session checks above go red, which is the
// distinction that matters.
{
	const uciOnly = [ iface('wan', { up: true, gw: '1.1.1.1',
	                                 uciProto: 'pppoe', uciDev: 'eth0.2' }) ];
	const r = clsGen.classify(uciOnly, [ '', '' ], true);

	chk('uci values are used when netifd has none',
	    'wan: pppoe, eth0.2, up', r.all[0].label);
	chk('and the role is still decided correctly', 'uplink', r.all[0].role);
}

// loopback is never a candidate.
{
	const r = clsGen.classify([ iface('loopback', { up: true, gw: '127.0.0.1' }),
	                         RESTRICTED[1] ], [ '', '' ], true);

	chk('loopback is excluded', false, clsNames(r).indexOf('loopback') >= 0);
}

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
