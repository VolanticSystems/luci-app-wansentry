#!/bin/sh
# wansentry hardware test suite.
#
# Every behavioural claim this package makes that can be checked without a
# browser, as one runnable script. It exists because until 2026-08-25 all of it
# had been verified only by ad-hoc commands typed once and thrown away, so a
# later change could silently undo an earlier fix and nothing would notice.
#
# RUN IT ON A SANDBOX ROUTER, NOT A PRODUCTION ONE. It stops, starts, enables
# and disables mwan3, and it rewrites /etc/config/mwan3 many times. It backs up
# both config files and restores them on exit, including on interrupt, but a
# router that is actually carrying traffic should not be the one you test on.
#
#   usage:  sh hardware-suite.sh            run everything
#           sh hardware-suite.sh arming     run one group (arming|ownership|security)
#
# Exit status is the number of failed checks, so it is usable from CI or a
# wrapper. Requires: mwan3 installed, wansentry installed, root.

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
BK=/tmp/wansentry-suite-backup.$$
mkdir -p "$BK"

say()  { printf '%s\n' "$*"; }
head2() { printf '\n=== %s ===\n' "$*"; }
ok()   { PASS=$((PASS+1)); printf '  PASS  %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$*"; }
chk()  { # chk <description> <expected> <actual>
	if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$2', got '$3')"; fi
}

# ---------------------------------------------------------------- fixtures

backup() {
	cp /etc/config/mwan3 "$BK/mwan3" 2>/dev/null
	cp /etc/config/wansentry "$BK/wansentry" 2>/dev/null
	[ -f /etc/init.d/mwan3.real ] || cp /etc/init.d/mwan3 "$BK/mwan3.init"
}

restore() {
	# Undo the call shim first; leaving it behind would break the router.
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

wipe_mwan3() {
	for s in $(uci show mwan3 2>/dev/null | grep -oE '^mwan3\.[^.]+=' | sed 's/mwan3\.//;s/=//'); do
		uci -q delete "mwan3.$s"
	done
	uci set mwan3.globals=globals
	uci set mwan3.globals.mmx_mask='0x3F00'
}

# A wansentry-owned interface section, as generator.js desired() would write it.
own_iface() {
	uci set "mwan3.$1=interface"
	uci set "mwan3.$1.enabled=1";        uci set "mwan3.$1.family=ipv4"
	uci set "mwan3.$1.initial_state=online"; uci set "mwan3.$1.track_method=ping"
	uci add_list "mwan3.$1.track_ip=$2"
	uci set "mwan3.$1.reliability=1";    uci set "mwan3.$1.count=1"
	uci set "mwan3.$1.timeout=4";        uci set "mwan3.$1.interval=5"
	uci set "mwan3.$1.down=3";           uci set "mwan3.$1.up=6"
	uci set "mwan3.$1.wansentry=1"
}

own_policy() {
	uci set mwan3.wansentry_primary=member
	uci set mwan3.wansentry_primary.interface="$1"
	uci set mwan3.wansentry_primary.metric=1; uci set mwan3.wansentry_primary.weight=1
	uci set mwan3.wansentry_primary.wansentry=1
	uci set mwan3.wansentry_fail=policy
	uci add_list mwan3.wansentry_fail.use_member=wansentry_primary
	uci set mwan3.wansentry_fail.last_resort=default
	uci set mwan3.wansentry_fail.wansentry=1
}

# Run the REAL reconciler and report what it did to the mwan3 service.
#
# An earlier version of this suite reimplemented the reconciler's ownership
# arithmetic here and asserted on the copy. That was worthless: every one of
# those checks passed against the known-broken v1.0.1 reconciler, because the
# copy was correct even when the shipped code was not. A test that cannot fail
# on the defect it describes is decorative, and five of them were.
#
# Everything below now drives /etc/init.d/wansentry and observes the service.
#
# `reconcile` echoes: "<ran|DIDNOTRUN> <calls>" where calls is the shim log.
RELOAD_RC=1
reconcile() {
	: > /tmp/mwan3-calls.log
	/etc/init.d/wansentry reload >/dev/null 2>&1
	RELOAD_RC=$?
	sleep 6
	if [ "$(grep -c . /tmp/mwan3-calls.log)" -eq 0 ]; then
		# The reconciler touching nothing is a legitimate outcome (the ownership
		# gate hands off), so this is reported rather than failed. What must
		# never happen is a test reading an empty log as proof of good
		# behaviour, which is how the restart-discipline checks silently
		# stopped testing anything.
		echo "nocalls"
	else
		tr '
' ' ' < /tmp/mwan3-calls.log
	fi
}

# Assert that the last reconcile ACTUALLY RAN, for the cases where a correct
# run leaves no trace.
#
# A hand-off is DEFINED by making no calls, so its shim log is empty, so
# `chk ... "NO" "$(tore_down)"` is satisfied by a reconciler that never ran at
# all. Gut reload_service() to `return 0`, drop the trigger from
# service_triggers(), or chmod -x the init script, and the two hand-off checks
# in test_ownership below stayed green through all of it.
#
# Found by an independent review panel on 2026-08-26 and confirmed against this
# file. The galling part is that the guard already existed twenty lines up, in
# test_no_spurious_restart, added deliberately after the restart-discipline
# checks were caught asserting on an empty log. The lesson was learned in one
# function and never carried to the other.
#
# `/etc/init.d/wansentry reload` is synchronous: rc.common calls
# reload_service(), which calls reconcile(), before returning. Its exit status
# is therefore evidence the function ran, and it is the one piece of evidence a
# correct hand-off cannot erase.
assert_ran() {
	chk "the reconciler ran (reload returned 0)" "0" "$RELOAD_RC"
}

# Did the reconciler stop or disable mwan3 during the last reconcile?
tore_down() {
	grep -qE ' (stop|disable)$' /tmp/mwan3-calls.log && echo YES || echo NO
}

restarted() {
	grep -q ' restart$' /tmp/mwan3-calls.log && echo YES || echo NO
}

# Ask the SHIPPED mwan3_armed() by sourcing the installed init script in a
# subshell. Reimplementing the grep here is what made the arming checks pass
# against the broken v1.0.1 version, so this must keep calling the real thing.
#
# Sourcing is safe and needs no stubbing: the file's `#!/bin/sh /etc/rc.common`
# is the mechanism by which rc.common sources IT when executed, and is an
# ordinary comment when we source it ourselves. Nothing runs at top level except
# the variable assignments and the function definitions.
#
# An earlier version pre-set START/STOP/USE_PROCD here "so sourcing cannot start
# anything". They were overwritten by the script's own values on the next line
# and did nothing, while tripping SC2034 twice.
armed() {
	(
		# shellcheck disable=SC1091
		. /etc/init.d/wansentry 2>/dev/null
		mwan3_armed >/dev/null 2>&1 && echo TRUE || echo FALSE
	)
}

# Count mwan3's rc.d entries with a glob rather than `ls | grep`, which SC2010
# rightly objects to and which would miscount on odd filenames.
#
# Mind the wrapping here: a comment line that BEGINS with "# shellcheck" is
# parsed as a directive, so wrapping this sentence so the tool's name landed at
# the start of the second line produced SC1073/SC1072 and failed the job.
symlinks() {
	local n=0 f
	for f in /etc/rc.d/*mwan3; do
		[ -e "$f" ] && n=$((n + 1))
	done
	echo "$n"
}
running()  { /etc/init.d/mwan3 running >/dev/null 2>&1 && echo YES || echo NO; }

# Replace /etc/init.d/mwan3 with a logging shim so a test can assert on what the
# reconciler INVOKED, rather than inferring it from side effects. Inferring was
# tried first and gave two false failures: mwan3track respawns per interface on
# its own, so comparing pids reports a restart that never happened.
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
	# Any `mwan3.real enable` during the run writes /etc/rc.d/S19mwan3.real.
	# Left behind it inflates every symlink count by one, and an earlier version
	# of this suite had its expected values calibrated against exactly that
	# contamination -- so the numbers looked right and were measuring junk.
	rm -f /etc/rc.d/*mwan3.real*
}

# ---------------------------------------------------------------- ownership

test_ownership() {
	head2 "OWNERSHIP GATE (does the REAL reconciler touch what it must not?)"
	shim_on

	# Every case runs with enabled=0, the shipped default and the dangerous
	# state: it is what a router looks like after installing this package and
	# before ever opening the settings page. If the gate is wrong here, the
	# package tears down a stranger's mwan3 on a config it has never managed.
	# Takes no arguments: the unknown-section-type case builds its own fixture
	# below, because that one must contain ONLY the unknown type.
	arm_foreign_mwan3() {   # a running, hand-configured mwan3 with no marker
		wipe_mwan3
		uci set mwan3.wan=interface; uci set mwan3.wan.enabled=1
		uci set mwan3.hand_m=member; uci set mwan3.hand_m.interface=wan
		uci set mwan3.hand_p=policy; uci add_list mwan3.hand_p.use_member=hand_m
		uci commit mwan3
		uci set wansentry.main.enabled=0; uci commit wansentry
		/etc/init.d/mwan3 enable >/dev/null 2>&1
		/etc/init.d/mwan3.real restart >/dev/null 2>&1; sleep 15
	}

	# ONLY an unknown type, with no interface/member/policy/rule anywhere. That
	# is the precise shape of the hole: v1.0.1 counted `managed` as those four
	# types alone, so this config measured owned=0 managed=0 foreign=0 and fell
	# through to the tear-down branch. Adding a real interface to this fixture
	# hides the defect, because then the old arithmetic sees foreign>0 and hands
	# off for the wrong reason -- which is exactly what an earlier version of
	# this check did, and why it passed against the broken code.
	wipe_mwan3
	uci set mwan3.mynotify=notify; uci set mwan3.mynotify.enabled=1
	uci commit mwan3
	uci set wansentry.main.enabled=0; uci commit wansentry
	/etc/init.d/mwan3 enable >/dev/null 2>&1
	/etc/init.d/mwan3.real restart >/dev/null 2>&1; sleep 15
	reconcile >/dev/null
	assert_ran
	chk "an UNKNOWN section type is foreign: mwan3 left alone" "NO" "$(tore_down)"

	arm_foreign_mwan3
	reconcile >/dev/null
	assert_ran
	chk "a foreign interface is foreign: mwan3 left alone" "NO" "$(tore_down)"

	# Owned-and-disabled MUST be torn down: that is the rolled-back first enable
	# the gate exists to catch. If this stops failing to act, the ownership gate
	# has become "never touch anything", which is a different bug.
	wipe_mwan3; own_iface wan 1.1.1.1; own_policy wan; uci commit mwan3
	uci set wansentry.main.enabled=0; uci commit wansentry
	/etc/init.d/mwan3 enable >/dev/null 2>&1
	/etc/init.d/mwan3.real restart >/dev/null 2>&1; sleep 15
	reconcile >/dev/null
	chk "config wansentry OWNS, with enabled=0: mwan3 IS torn down" "YES" "$(tore_down)"

	wipe_mwan3; uci commit mwan3
	uci set wansentry.main.enabled=0; uci commit wansentry
	/etc/init.d/mwan3 enable >/dev/null 2>&1
	/etc/init.d/mwan3.real restart >/dev/null 2>&1; sleep 15
	reconcile >/dev/null
	chk "globals only (rolled-back first enable): mwan3 IS torn down" "YES" "$(tore_down)"

	shim_off
}

# ---------------------------------------------------------------- arming

test_arming() {
	head2 "ARMING (mwan3_armed must mean 'a policy is installed')"

	# armed() sources the SHIPPED mwan3_armed(); see its definition above.
	wipe_mwan3; own_iface wan 1.1.1.1; own_policy wan; uci commit mwan3
	/etc/init.d/mwan3 restart >/dev/null 2>&1; sleep 25
	chk "a member ONLINE reads as armed" "TRUE" "$(armed)"

	# Point the probe at a host that cannot answer, so every member goes offline
	# and only last_resort remains. This is the state the old check got wrong.
	uci -q delete mwan3.wan.track_ip; uci add_list mwan3.wan.track_ip=192.0.2.1
	uci commit mwan3; /etc/init.d/mwan3 restart >/dev/null 2>&1; sleep 45
	chk "every uplink OFFLINE still reads as armed (last_resort default)" \
	    "TRUE" "$(armed)"

	uci -q delete mwan3.wansentry_fail; uci commit mwan3
	/etc/init.d/mwan3 restart >/dev/null 2>&1; sleep 20
	chk "NO policy installed reads as NOT armed (the original bug)" \
	    "FALSE" "$(armed)"
}

test_no_spurious_restart() {
	head2 "RECONCILER RESTART DISCIPLINE (observed, and proven to have run)"
	shim_on

	# EVERY "did not do X" check here first proves the reconciler RAN. Without
	# that, an empty log reads as good behaviour, and an earlier version of this
	# suite drove the reconciler through `uci commit` expecting a procd reload
	# trigger. Measured 2026-08-25: a CLI `uci commit` fires nothing at all, so
	# those checks asserted on an empty log and passed against the known-broken
	# v1.0.1 reconciler. `ubus call service event config.change` DOES fire it,
	# which is the path LuCI's apply uses, and an explicit `reload` fires it
	# too; this suite uses `reload` because it is synchronous.
	wipe_mwan3; own_iface wan 1.1.1.1; own_policy wan; uci commit mwan3
	uci set wansentry.main.enabled=1; uci set wansentry.main.primary=wan; uci commit wansentry
	/etc/init.d/mwan3.real restart >/dev/null 2>&1; sleep 25

	CALLS=$(reconcile)
	if [ "$CALLS" = "nocalls" ]; then
		bad "the reconciler did not run at all with an armed, owned config"
	else
		ok "the reconciler ran (calls: $CALLS)"
		chk "an ordinary reload does not restart an ARMED mwan3" "NO" "$(restarted)"
	fi

	# Every uplink offline: the policy is still installed via last_resort, so
	# this is still armed and still must not be restarted. This is the case the
	# v1.0.1 percentage grep got backwards.
	uci -q delete mwan3.wan.track_ip; uci add_list mwan3.wan.track_ip=192.0.2.1
	uci commit mwan3; /etc/init.d/mwan3.real restart >/dev/null 2>&1; sleep 50
	chk "fixture: every uplink offline, policy still installed" "TRUE" "$(armed)"
	CALLS=$(reconcile)
	if [ "$CALLS" = "nocalls" ]; then
		bad "the reconciler did not run at all during a dual outage"
	else
		chk "a reload during a DUAL OUTAGE does not restart mwan3" "NO" "$(restarted)"
	fi

	# No policy at all: genuinely unarmed, and this one MUST be restarted.
	uci -q delete mwan3.wansentry_fail; uci commit mwan3
	/etc/init.d/mwan3.real restart >/dev/null 2>&1; sleep 20
	chk "fixture: no policy installed, so not armed" "FALSE" "$(armed)"
	CALLS=$(reconcile)
	if [ "$CALLS" = "nocalls" ]; then
		bad "the reconciler did not run at all with an unarmed mwan3"
	else
		chk "an UNARMED mwan3 IS restarted (the original bug stays caught)" 		    "YES" "$(restarted)"
	fi

	shim_off
}

# ---------------------------------------------------------------- security

test_security() {
	head2 "SECURITY: an unreadable mwan3 is UNKNOWN, not empty"

	# A hand-configured mwan3 carrying no wansentry marker at all.
	wipe_mwan3
	uci set mwan3.wan=interface; uci set mwan3.wan.enabled=1
	uci set mwan3.hand_m=member; uci set mwan3.hand_m.interface=wan
	uci set mwan3.hand_p=policy; uci add_list mwan3.hand_p.use_member=hand_m
	uci commit mwan3
	uci set wansentry.main.enabled=0; uci commit wansentry
	cp /etc/config/mwan3 "$BK/hand"
	/etc/init.d/mwan3 enable >/dev/null 2>&1
	/etc/init.d/mwan3 restart >/dev/null 2>&1; sleep 18
	chk "fixture: a foreign mwan3 is running with its boot symlink" \
	    "1 YES" "$(symlinks) $(running)"

	echo "option broken 'unterminated" >> /etc/config/mwan3
	uci -q show mwan3 >/dev/null 2>&1 \
	  && bad "fixture: uci still reads the corrupted config; the test is inert" \
	  || ok "fixture: uci cannot read the corrupted config"
	/etc/init.d/wansentry start >/dev/null 2>&1; sleep 4
	chk "a parse error must NOT stop or disable a foreign mwan3" \
	    "1 YES" "$(symlinks) $(running)"

	cp "$BK/hand" /etc/config/mwan3
	/etc/init.d/mwan3 enable >/dev/null 2>&1
	mv /etc/config/mwan3 "$BK/away"
	uci -q show mwan3 >/dev/null 2>&1 \
	  && bad "fixture: uci still reads the absent config; the test is inert" \
	  || ok "fixture: uci cannot read the absent config"
	/etc/init.d/wansentry start >/dev/null 2>&1; sleep 4
	chk "a missing config must NOT stop or disable a foreign mwan3" \
	    "1 YES" "$(symlinks) $(running)"
	mv "$BK/away" /etc/config/mwan3

	head2 "SECURITY: the legitimate disable path still works"
	# A rolled-back FIRST enable: config reverted to globals-only, but the rc.d
	# symlink written during the apply window survives, because UCI rollback
	# does not cover it. This one SHOULD be reconciled down.
	wipe_mwan3; uci commit mwan3
	uci set wansentry.main.enabled=0; uci commit wansentry
	/etc/init.d/mwan3 enable >/dev/null 2>&1
	/etc/init.d/mwan3 restart >/dev/null 2>&1; sleep 15
	/etc/init.d/wansentry start >/dev/null 2>&1; sleep 5
	chk "a rolled-back first enable IS reconciled down" \
	    "0 NO" "$(symlinks) $(running)"

	head2 "SECURITY: the ACL grants no more than the package uses"
	A=/usr/share/rpcd/acl.d/luci-app-wansentry.json
	if grep -q '"network"' "$A" 2>/dev/null; then
		bad "the ACL still grants uci read on 'network' (PPPoE/wireguard secrets)"
	else
		ok "the ACL does not grant uci read on 'network'"
	fi
}

# ---------------------------------------------------------------- run

say "wansentry hardware suite"
say "router: $(uci -q get system.@system[0].hostname 2>/dev/null || echo '?')  group: $GROUP"
backup

case "$GROUP" in
	ownership) test_ownership ;;
	arming)    test_arming; test_no_spurious_restart ;;
	security)  test_security ;;
	all)       test_ownership; test_arming; test_no_spurious_restart; test_security ;;
	*)         say "unknown group '$GROUP' (ownership|arming|security|all)"; exit 2 ;;
esac

printf '\n----------------------------------------\n'
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
