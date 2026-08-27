#!/bin/sh
# wansentry ownership-arithmetic suite.
#
# The sibling suite, hardware-suite.sh, checks that the reconciler behaves on
# the four config shapes that actually occur: a foreign mwan3, an unknown
# section type, an owned config with enabled=0, and a globals-only rollback. It
# is the right suite and it stays.
#
# This one attacks the same gate from the other end. The ownership rule is
# implemented TWICE -- once in the browser as audit()/isOwned() in
# generator.js, and once on the router as the owned/managed/foreign arithmetic
# in reconcile(). DESIGN 6.3 says the two must agree, and the whole safety
# promise of the package rests on that: the generator refuses to WRITE mwan3
# config it did not create, and the service must refuse just as hard, or it
# stops a stranger's mwan3 at boot before the settings page has ever been
# opened.
#
# Two implementations of one rule is a shape that drifts. It has drifted twice
# already, both times in the dangerous direction, and both times the fix was
# made to the service side to match the browser (see the comment block above
# the ownership gate in root/etc/init.d/wansentry). So the cases below are
# chosen to be the ones where the two READINGS COULD DIVERGE, not the ones a
# user is likely to have. That is the point: a case a user is likely to have is
# a case somebody already thought about.
#
#   usage:  sh ownership-suite.sh                run everything
#           sh ownership-suite.sh divergence     run one group
#             (divergence|values|robustness|acl)
#
# RUN IT ON A SANDBOX ROUTER, NOT A PRODUCTION ONE. It rewrites
# /etc/config/mwan3 repeatedly and drives the mwan3 service. It backs up both
# config files and restores them on exit, including on interrupt.
#
# Exit status is the number of failed checks. Requires mwan3 and wansentry
# installed, and root.
#
# ---------------------------------------------------------------------------
# THE `SABOTAGE:` COMMENTS
#
# Every check names the smallest edit to the PRODUCT that turns it red, written
# before the assertion. See the same header in the appflow protocol suite for
# why that ordering is the whole discipline rather than a house style.
#
# Where a check is currently RED, there is no sabotage to name -- the product
# is already in the state the check is written to detect, and the comment says
# so and cites what it contradicts instead.
# ---------------------------------------------------------------------------

set -u

# ---------------------------------------------------------------- exclusivity
#
# Every suite in these two packages mutates GLOBAL router state: this one
# rewrites /etc/config/mwan3 and drives the mwan3 service, its sibling repoints
# appflow.socket_path and restarts appflowd. Two of them running at once
# corrupt each other's fixtures, and the failures look like product defects.
#
# That is not hypothetical. On 2026-08-26 two suites were launched a minute
# apart against the same router; the second reported two failures that could
# not be reproduced in isolation, and the ownership arithmetic was rewritten
# twice chasing a bug that was never there.
#
# One lock file for ALL suites across both packages, because the resource being
# protected is the router, not the config file.
# mkdir is atomic and is NOT a file descriptor, which is the whole point.
# The first version of this guard used `exec 9>lock; flock -n 9`. Every child
# inherits an fd, and these suites launch children that outlive them: socat
# serving the fake agent, and mwan3track respawned per interface by mwan3's
# init script. The lock therefore stayed held after the suite exited and the
# next suite in a serial run was refused. Observed: suite 1 passed, suites 2
# and 3 produced no output at all because both exited 2.
SUITE_LOCK=/tmp/openwrt-suite.lock.d
if ! mkdir "$SUITE_LOCK" 2>/dev/null; then
	# Someone holds it, or a killed run left it behind. Only the second is
	# ours to clear, and only when the recorded pid is provably gone.
	stale=1
	if [ -r "$SUITE_LOCK/pid" ]; then
		kill -0 "$(cat "$SUITE_LOCK/pid" 2>/dev/null)" 2>/dev/null && stale=0
	fi
	if [ "$stale" = 1 ]; then
		printf 'clearing a stale suite lock (%s)\n' "$SUITE_LOCK"
		rm -rf "$SUITE_LOCK"
		mkdir "$SUITE_LOCK" 2>/dev/null || { printf "cannot take the suite lock\n"; exit 2; }
	else
		printf 'another test suite is running on this router (pid %s).\n' \
		       "$(cat "$SUITE_LOCK/pid" 2>/dev/null)"
		printf 'they mutate shared router state; run them one at a time.\n'
		exit 2
	fi
fi
echo $$ > "$SUITE_LOCK/pid"

GROUP="${1:-all}"
PASS=0; FAIL=0
BK=/tmp/wansentry-own-backup.$$
mkdir -p "$BK"

head2() { printf '\n=== %s ===\n' "$*"; }
ok()   { PASS=$((PASS+1)); printf '  PASS  %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$*"; }
note() { printf '        %s\n' "$*"; }

chk() {
	if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$2', got '$3')"; fi
}

# ------------------------------------------------------------------ fixtures

backup() {
	cp /etc/config/mwan3 "$BK/mwan3" 2>/dev/null
	cp /etc/config/wansentry "$BK/wansentry" 2>/dev/null
	[ -f /etc/init.d/mwan3.real ] || cp /etc/init.d/mwan3 "$BK/mwan3.init"
}

restore() {
	if [ -f /etc/init.d/mwan3.real ]; then
		mv -f /etc/init.d/mwan3.real /etc/init.d/mwan3
		chmod +x /etc/init.d/mwan3
	fi
	[ -f "$BK/mwan3" ]     && cp "$BK/mwan3" /etc/config/mwan3
	[ -f "$BK/wansentry" ] && cp "$BK/wansentry" /etc/config/wansentry
	uci commit mwan3 2>/dev/null
	uci commit wansentry 2>/dev/null
	/etc/init.d/mwan3 restart >/dev/null 2>&1
	rm -rf "$BK" /tmp/mwan3-calls.log
	rm -f /etc/rc.d/*mwan3.real*
	printf '\nrestored /etc/config/mwan3 and /etc/config/wansentry\n'
	rm -rf "$SUITE_LOCK"
}
# HUP IS IN THAT LIST DELIBERATELY. These suites are normally run over SSH, and
# a dropped session sends SIGHUP, which the original INT/TERM/EXIT list did not
# catch: the process died without running the trap. Observed 2026-08-26, where
# it left a stale lock behind. The lock self-heals; what would NOT self-heal is
# the rest of what this trap undoes -- the mwan3 init-script shim, a rewritten
# /etc/config/mwan3, or appflow left pointed at a socket that no longer exists.
# A router in that state looks broken and gives no clue why.
trap 'restore; exit $FAIL' INT TERM HUP EXIT

# The logging shim, same mechanism the sibling suite uses: replace the mwan3
# init script with one that records what it was asked to do and then does it.
#
# Observing the CALL rather than the side effect is deliberate and was learned
# the hard way there: mwan3track respawns per interface on its own, so
# comparing pids reports a restart that never happened.
shim_on() {
	[ -f /etc/init.d/mwan3.real ] && return 0
	cp /etc/init.d/mwan3 /etc/init.d/mwan3.real
	cat > /etc/init.d/mwan3 <<'SHIM'
#!/bin/sh
echo "mwan3 $*" >> /tmp/mwan3-calls.log
exec /etc/init.d/mwan3.real "$@"
SHIM
	chmod +x /etc/init.d/mwan3
}

shim_off() {
	[ -f /etc/init.d/mwan3.real ] || return 0
	mv -f /etc/init.d/mwan3.real /etc/init.d/mwan3
	chmod +x /etc/init.d/mwan3
	rm -f /etc/rc.d/*mwan3.real*
}

wipe_mwan3() {
	for s in $(uci show mwan3 2>/dev/null | grep -oE '^mwan3\.[^.]+=' | sed 's/mwan3\.//;s/=//'); do
		uci -q delete "mwan3.$s"
	done
	uci set mwan3.globals=globals
	uci set mwan3.globals.mmx_mask='0x3F00'
}

# Run the REAL reconciler and report what it did.
#
# Nothing here reimplements the ownership arithmetic. An earlier version of the
# sibling suite did exactly that and every one of those checks passed against
# the known-broken v1.0.1 reconciler, because the copy in the test was correct
# even when the shipped code was not.
RELOAD_RC=1
reconcile() {
	: > /tmp/mwan3-calls.log
	/etc/init.d/wansentry reload >/dev/null 2>&1
	RELOAD_RC=$?
	sleep 5
}

tore_down() { grep -qE ' (stop|disable)$' /tmp/mwan3-calls.log && echo YES || echo NO; }

# PROVING THE RECONCILER RAN, WHEN A CORRECT RUN PRODUCES NO EVIDENCE.
#
# This is the hard part of testing a hand-off and the first version of this file
# got it wrong. It had a `ran()` helper that reported YES when the shim log was
# non-empty, and every case asserted on it. That is incoherent: a hand-off is
# DEFINED by making no calls, so its log is empty, so `ran()` said NO and the
# fixture check failed on exactly the cases that were behaving correctly. It
# reported a failure on the control case while the real finding sat two lines
# below it.
#
# The deeper problem is that an empty log genuinely cannot distinguish "handed
# off correctly" from "never ran at all", and the second is the single easiest
# way to make every hand-off check in this file green while testing nothing.
# The sibling suite lost a whole group to it: those checks drove the reconciler
# through `uci commit`, which fires no procd trigger, so they asserted on an
# empty log and passed against the known-broken v1.0.1 reconciler.
#
# So the proof is split in two, and neither half is dropped:
#
#   1. `/etc/init.d/wansentry reload` is SYNCHRONOUS -- rc.common calls
#      reload_service(), which calls reconcile(), before returning. Its exit
#      status is therefore evidence the function ran, and it is evidence a
#      hand-off cannot destroy. That is RELOAD_RC.
#   2. A POSITIVE CONTROL at the top of each group drives a config that MUST
#      produce calls. If the shim, the trigger, or the init script is broken,
#      that control fails loudly ONCE, instead of every hand-off check below it
#      passing for the wrong reason.
#
# Check 1 alone would pass if reload_service were gutted to `return 0`. Check 2
# alone would not notice a per-case fixture that failed to commit. Together they
# bound it.
assert_ran() {
	chk "the reconciler ran (reload returned 0)" "0" "$RELOAD_RC"
}

# Run once per group, before any hand-off assertion in it.
positive_control() {
	wipe_mwan3
	uci set mwan3.pc_iface=interface
	uci set mwan3.pc_iface.enabled=1
	uci set mwan3.pc_iface.wansentry=1
	arm
	reconcile
	if [ "$(tore_down)" = "YES" ]; then
		ok "positive control: the shim records calls and the trigger fires"
		return 0
	fi
	bad "positive control FAILED: no calls recorded for a config that must be torn down."
	note "Every hand-off check in this group would now pass for the wrong reason."
	note "Not running them; fix the harness first."
	return 1
}

assert_handoff() { # assert_handoff <description>
	assert_ran
	chk "$1" "NO" "$(tore_down)"
}

assert_teardown() { # assert_teardown <description>
	assert_ran
	chk "$1" "YES" "$(tore_down)"
}

# Build a config, commit it, and put wansentry in the shipped default state.
#
# enabled=0 throughout, on purpose: that is what a router looks like after
# installing this package and before the settings page has ever been opened,
# and it is the state in which the else-branch tears mwan3 down. Every gate
# failure is dangerous in exactly this state and harmless in the other one.
arm() {
	uci commit mwan3
	uci set wansentry.main.enabled=0
	uci commit wansentry
	/etc/init.d/mwan3 enable >/dev/null 2>&1
}

# ---------------------------------------------------------------- divergence

test_divergence() {
	head2 "DIVERGENCE: the browser's rule and the router's rule must agree"
	shim_on
	positive_control || { shim_off; return; }

	# CASE 1 -- the control. An unknown section type with an ordinary name.
	#
	# Browser: audit() puts any type outside [interface, member, policy, rule]
	# straight into `foreign`, so the form goes read-only and refuses to write.
	# Router: `managed` counts every non-globals section, `owned` matches
	# neither test, so foreign = 1 and the gate hands off.
	# The two agree. This is the case the v1.0.1 fix was written for and the
	# sibling suite already covers it; it is repeated here as the baseline the
	# next case is varied from, so a failure below cannot be blamed on the
	# fixture.
	#
	# SABOTAGE: in reconcile(), narrow `managed` back to
	#   grep -E "=(interface|member|policy|rule)$"
	# which is what v1.0.1 counted. foreign becomes 0, the else-branch runs, and
	# this goes red.
	wipe_mwan3
	uci set mwan3.mynotify=notify
	uci set mwan3.mynotify.enabled=1
	arm
	reconcile
	assert_handoff "an unknown type with an ordinary name is foreign: mwan3 left alone"

	# CASE 2 -- the same shape, renamed into the wansentry_ namespace.
	#
	# This is the ONLY difference from case 1: the section name. Nothing about
	# what the section IS has changed, and neither has its type.
	#
	#   Browser  audit(): type 'notify' is not in MANAGED_TYPES, so it is
	#            classified FOREIGN before isOwned() is ever consulted. The
	#            form goes read-only and names it in the banner.
	#   Router   reconcile(): `owned` matches on the name alone --
	#              s/^mwan3\.\(wansentry_[^.]*\)=.*/\1/p
	#            -- with no test of the section's type. So owned = 1,
	#            managed = 1, foreign = 0, the gate does NOT hand off, and with
	#            enabled=0 the else-branch stops and disables mwan3.
	#
	# THIS CHECK WAS RED WHEN IT WAS WRITTEN. It is the reason the ownership
	# arithmetic now gates both tests on the section's type, and it stays as the
	# regression guard for that fix.
	#
	# SABOTAGE: in reconcile(), drop the type constraint from the `managed_names`
	# sed so it matches every section rather than only the four managed types:
	#     s/^mwan3\.\([^.]*\)=.*$/\1/p
	# The intersection then admits `wansentry_notify`, owned goes to 1,
	# foreign falls to 0, the else-branch tears down, and this goes red again.
	#
	# WHO CAN ACTUALLY DO THIS, stated plainly so the finding is not oversold:
	# /etc/config/mwan3 is root:root and root is the only account with a shell
	# on stock OpenWrt, so this is NOT an attacker-reachable bug and should not
	# be described as one. It is reachable by a coexisting package, by a hand
	# edit, and by wansentry's own future self the moment it generates a
	# section of a type this list does not name. What makes it worth fixing is
	# not exploitability, it is that the two halves of one rule disagree, on
	# the exact shape the rule exists to protect.
	wipe_mwan3
	uci set mwan3.wansentry_notify=notify
	uci set mwan3.wansentry_notify.enabled=1
	arm
	reconcile
	assert_handoff "an unknown type NAMED wansentry_* is still foreign: mwan3 left alone"

	# CASE 3 -- a foreign managed-type section carrying the marker option.
	#
	# Here the two agree and both call it owned, which is correct: the option is
	# the marker the generator writes, and anything carrying it is by definition
	# claimed. Included so case 2 cannot be read as "the namespace test is
	# wrong" -- the option test is fine and this proves it is exercised.
	#
	# SABOTAGE: in reconcile(), change the owned sed's option pattern from
	#   \.wansentry='1'$    to    \.wansentry='0'$
	# owned drops to 0, foreign becomes 1, the gate hands off, and this goes red.
	wipe_mwan3
	uci set mwan3.some_iface=interface
	uci set mwan3.some_iface.enabled=1
	uci set mwan3.some_iface.wansentry=1
	arm
	reconcile
	assert_teardown "a managed section carrying the marker IS ours, so enabled=0 tears down"

	shim_off
}

# -------------------------------------------------------------------- values

test_values() {
	head2 "MARKER VALUES: only the value the generator writes counts as owned"
	shim_on
	positive_control || { shim_off; return; }

	# The generator writes `option wansentry '1'` and the service matches on
	# exactly '1'. Anything else must NOT be read as ownership, or a half-
	# written or hand-edited marker silently hands a stranger's section to us.
	#
	# Each case below is one foreign interface carrying a near-miss marker. The
	# gate must see foreign = 1 and hand off every time.
	#
	# SABOTAGE for all four: in reconcile(), loosen the owned sed's option
	# pattern from
	#   s/^mwan3\.\([^.]*\)\.wansentry='1'$/\1/p
	# to
	#   s/^mwan3\.\([^.]*\)\.wansentry=.*/\1/p
	# Every near-miss below then counts as owned, foreign falls to 0, the
	# else-branch tears down, and all four go red at once.
	for v in 0 true yes 11; do
		wipe_mwan3
		uci set mwan3.near_miss=interface
		uci set mwan3.near_miss.enabled=1
		uci set mwan3.near_miss.wansentry="$v"
		arm
		reconcile
		assert_handoff "marker value '$v' does not confer ownership: mwan3 left alone"
	done

	shim_off
}

# ---------------------------------------------------------------- robustness

test_robustness() {
	head2 "ROBUSTNESS: the gate still holds on a config far larger than expected"
	shim_on
	positive_control || { shim_off; return; }

	# 300 foreign sections. The counting is done with sed/grep over a uci dump,
	# and the arithmetic is a shell subtraction; neither has a documented bound.
	# A config this size is not realistic, but the failure mode if one of the
	# pipelines truncated or the subtraction went wrong is that foreign reads 0
	# and a stranger's mwan3 is torn down, which is the worst outcome the
	# package has.
	#
	# SABOTAGE: in reconcile(), pipe the `owned` count through `head -20`.
	# owned is then capped while managed is not, so foreign stays positive and
	# this check keeps passing -- which is why the SECOND check below exists,
	# with the arithmetic pointed the other way.
	wipe_mwan3
	i=1
	while [ "$i" -le 300 ]; do
		uci set "mwan3.bulk$i=interface"
		uci set "mwan3.bulk$i.enabled=1"
		i=$((i + 1))
	done
	arm
	reconcile
	assert_handoff "300 foreign sections: mwan3 left alone"

	# The mirror. 300 sections that ARE ours, with enabled=0, must still be
	# recognised as ours and reconciled down. If the `owned` pipeline truncated
	# anywhere, owned < managed here, foreign goes positive and the gate hands
	# off -- leaving an mwan3 that wansentry wrote, enabled, with the settings
	# page saying it is off.
	#
	# SABOTAGE: the `head -20` edit named above. owned caps at 20 against
	# managed 300, foreign becomes 280, the gate hands off and this goes red.
	# Together the two checks bound the arithmetic from both sides; neither
	# does it alone.
	wipe_mwan3
	i=1
	while [ "$i" -le 300 ]; do
		uci set "mwan3.wansentry_bulk$i=interface"
		uci set "mwan3.wansentry_bulk$i.enabled=1"
		i=$((i + 1))
	done
	arm
	reconcile
	assert_teardown "300 owned sections with enabled=0: mwan3 IS torn down"

	head2 "ROBUSTNESS: a section counted twice must not be counted twice"

	# Every section the generator writes matches BOTH ownership tests: it is in
	# the wansentry_ namespace and it carries the marker option. The sed emits a
	# line for each and `sort -u` collapses them.
	#
	# If that dedup were lost, owned would double while managed stayed put,
	# foreign would go NEGATIVE, and `[ "$foreign" -gt 0 ]` would be false -- so
	# the gate would fall through and tear down a config that contained genuinely
	# foreign sections. A negative count is not a rounding error here, it inverts
	# the safety decision.
	#
	# SABOTAGE: in reconcile(), delete `| sort -u` from the owned pipeline.
	# owned becomes 2 against managed 2 (one owned + one foreign), foreign
	# becomes 0, the gate stops handing off and this goes red.
	wipe_mwan3
	uci set mwan3.wansentry_both=interface
	uci set mwan3.wansentry_both.enabled=1
	uci set mwan3.wansentry_both.wansentry=1
	uci set mwan3.a_stranger=interface
	uci set mwan3.a_stranger.enabled=1
	arm
	reconcile
	assert_handoff "a doubly-marked section plus one foreign: mwan3 left alone"

	shim_off
}

# ----------------------------------------------------------------------- acl

test_acl() {
	head2 "ACL: every grant is one the package uses"

	local A=/usr/share/rpcd/acl.d/luci-app-wansentry.json
	[ -f "$A" ] || { bad "ACL file not installed"; return; }

	# SABOTAGE: add "network" back to the uci read list. That file holds PPPoE
	# and 802.1x credentials and wireguard private keys, and the grant was
	# removed on 2026-08-25 for that reason. This is a property of the ACL's
	# text, and the ACL's text is what rpcd enforces, so reading it is a binding
	# assertion rather than text standing in for a behaviour.
	if grep -q '"network"' "$A"; then
		bad "the ACL grants uci read on 'network' (PPPoE/wireguard secrets)"
	else
		ok "the ACL does not grant uci read on 'network'"
	fi

	# PARSE THE ACL, DO NOT PATTERN-MATCH IT.
	#
	# The first version of this group read the write block with
	#   sed -n '/"write"/,$p' | sed -n '/"uci"/,/]/p'
	# and asserted the result was `mwan3 wansentry`. It came back
	# `add apply confirm delete mwan3 order rename set wansentry` and read as a
	# defect in the ACL. It was not: this file has TWO things called `uci` in
	# its write block and they are different kinds of grant --
	#
	#   write.ubus.uci   [ add, apply, confirm, delete, order, rename, set ]
	#                    the uci ubus METHODS the session may call
	#   write.uci        [ mwan3, wansentry ]
	#                    the config FILES it may write
	#
	# -- and a line-range match cannot tell one from the other, so it silently
	# concatenated both. jsonfilter walks the structure and cannot make that
	# mistake. This is the brief's own point about structural checks beating
	# pattern matching, learned here rather than read.
	local files methods
	files=$(jsonfilter -i "$A" -e '@["luci-app-wansentry"].write.uci[*]' | sort | tr '\n' ' ')
	methods=$(jsonfilter -i "$A" -e '@["luci-app-wansentry"].write.ubus.uci[*]' | sort | tr '\n' ' ')

	# SABOTAGE: add "firewall" to the write.uci list in the ACL. This package
	# generates mwan3 config and nothing else; a write grant on a third config
	# file is a capability it has no use for, handed to a browser session.
	chk "the uci write grant names only this package's two config files" \
	    "mwan3 wansentry " "$files"

	# SABOTAGE: add "revert" or "reorder" to write.ubus.uci. Pinned as an exact
	# set rather than a floor, because this list is what the browser may do to
	# those two files and every addition is a new verb nobody asked for.
	chk "the uci ubus write methods are exactly the seven the generator uses" \
	    "add apply confirm delete order rename set " "$methods"

	# SABOTAGE: add "network" to read.uci. Checked separately from the write
	# list because read and write are separate grants and a package can leak
	# through either.
	#
	# THREE FILES, AND THE THIRD IS DELIBERATE. `pbr` was added on 2026-08-27
	# so the generator can read policy-based routing rules and emit the mwan3
	# exclusions that stop failover silently overriding them. It is pinned as
	# an exact set, not a floor, precisely so the next addition has to be
	# argued for here rather than slipped in.
	#
	# Why pbr is acceptable and `network` is not: /etc/config/pbr holds policy
	# names, addresses, interface names and ports. /etc/config/network holds
	# PPPoE passwords and WireGuard private keys, and an administrator who
	# restricted a user to failover settings would not expect that user to be
	# able to read them. The line is credentials, not tidiness.
	local rfiles
	rfiles=$(jsonfilter -i "$A" -e '@["luci-app-wansentry"].read.uci[*]' | sort | tr '\n' ' ')
	chk "the uci read grant names exactly mwan3, pbr and wansentry" \
	    "mwan3 pbr wansentry " "$rfiles"

	# The one exec grant must stay pinned to the exact command line, arguments
	# included. `logread` with different arguments is a different capability:
	# without `-e mwan3` it returns the whole system log to the browser.
	#
	# SABOTAGE: change the key to "/sbin/logread": [ "exec" ]. The grep below
	# stops matching and this goes red.
	if grep -q '"/sbin/logread -l 200 -e mwan3"' "$A"; then
		ok "the logread exec grant is pinned to a filtered command line"
	else
		bad "the logread exec grant is not the expected filtered command line"
	fi

	# A grant naming a ubus object that does not exist is dead text: it outlives
	# whatever it named, and it reads as capability the package still needs.
	#
	# SABOTAGE: add "mwan4": [ "status" ] to the ubus read block. The loop finds
	# no such object and this goes red.
	local o missing=""
	for o in $(sed -n '/"read"/,/"write"/p' "$A" | sed -n '/"ubus"/,/}/p' \
	           | grep -oE '^[[:space:]]+"[a-z0-9._-]+"' | tr -d ' "'); do
		[ "$o" = "ubus" ] && continue
		ubus list 2>/dev/null | grep -qx "$o" || missing="$missing $o"
	done
	if [ -z "$(echo "$missing" | tr -d ' ')" ]; then
		ok "every ubus object named in the read grant exists on this router"
	else
		note "not present:$missing"
		bad "the ACL names ubus objects that do not exist:$missing"
	fi
}

# ------------------------------------------------------------------------ run

printf 'wansentry ownership-arithmetic suite\n'
printf 'router: %s   group: %s\n' \
	"$(uci -q get system.@system[0].hostname 2>/dev/null || echo '?')" "$GROUP"

[ -f /etc/init.d/mwan3 ]     || { printf 'mwan3 is not installed\n'; exit 2; }
[ -f /etc/init.d/wansentry ] || { printf 'wansentry is not installed\n'; exit 2; }

backup

case "$GROUP" in
	divergence) test_divergence ;;
	values)     test_values ;;
	robustness) test_robustness ;;
	acl)        test_acl ;;
	all)        test_divergence; test_values; test_robustness; test_acl ;;
	*)          printf "unknown group '%s'\n" "$GROUP"; exit 2 ;;
esac

printf '\n----------------------------------------\n'
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
