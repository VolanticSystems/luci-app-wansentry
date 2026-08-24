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
	printf '\nrestored /etc/config/mwan3 and /etc/config/wansentry\n'
}
trap 'restore; exit $FAIL' INT TERM EXIT

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

# The reconciler's own ownership arithmetic, mirrored so the suite can assert on
# it directly rather than only on its side effects.
gate() {
	local dump rc owned managed
	dump=$(uci -q show mwan3 2>/dev/null); rc=$?
	[ "$rc" -ne 0 ] && { echo "UNREADABLE"; return; }
	owned=$(printf '%s\n' "$dump" \
		| sed -n "s/^mwan3\.\([^.]*\)\.wansentry='1'$/\1/p; s/^mwan3\.\(wansentry_[^.]*\)=.*/\1/p" \
		| sort -u | grep -c .)
	managed=$(printf '%s\n' "$dump" | grep -E "^mwan3\.[^.]+=" | grep -vc "=globals$")
	echo "owned=$owned managed=$managed foreign=$(( managed - owned ))"
}

armed() {
	/etc/init.d/mwan3 running >/dev/null 2>&1 || { echo FALSE; return; }
	mwan3 policies 2>/dev/null | grep -qE '^[[:space:]]+[^[:space:]]' && echo TRUE || echo FALSE
}

symlinks() { ls /etc/rc.d/ 2>/dev/null | grep -c mwan3; }
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
}

# ---------------------------------------------------------------- ownership

test_ownership() {
	head2 "OWNERSHIP GATE (generator audit() and the reconciler must agree)"

	wipe_mwan3; uci set mwan3.mynotify=notify; uci commit mwan3
	chk "a foreign section of an UNKNOWN type counts as foreign" \
	    "owned=0 managed=1 foreign=1" "$(gate)"

	wipe_mwan3; uci set mwan3.wan=interface; uci commit mwan3
	chk "a foreign interface counts as foreign" \
	    "owned=0 managed=1 foreign=1" "$(gate)"

	wipe_mwan3
	own_iface wan 1.1.1.1
	uci set mwan3.wansentry_primary=member; uci set mwan3.wansentry_primary.wansentry=1
	uci set mwan3.wansentry_fail=policy;    uci set mwan3.wansentry_fail.wansentry=1
	uci commit mwan3
	chk "owned sections matching BOTH tests are not double counted" \
	    "owned=3 managed=3 foreign=0" "$(gate)"

	uci set mwan3.wansentry_orphan=member; uci commit mwan3
	chk "the wansentry_ prefix alone counts as owned, matching isOwned()" \
	    "owned=4 managed=4 foreign=0" "$(gate)"

	wipe_mwan3; uci commit mwan3
	chk "globals alone is not managed config" \
	    "owned=0 managed=0 foreign=0" "$(gate)"
}

# ---------------------------------------------------------------- arming

test_arming() {
	head2 "ARMING (mwan3_armed must mean 'a policy is installed')"

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
	head2 "RECONCILER RESTART DISCIPLINE (observed, not inferred)"
	shim_on

	wipe_mwan3; own_iface wan 1.1.1.1; own_policy wan; uci commit mwan3
	uci set wansentry.main.enabled=1; uci set wansentry.main.primary=wan; uci commit wansentry
	/etc/init.d/mwan3.real restart >/dev/null 2>&1; sleep 25

	# Let any procd reload trigger from the SETUP commits land before the log is
	# cleared, otherwise a late trigger -- fired while mwan3 was still unarmed
	# from the previous group, and therefore legitimately restarting it -- shows
	# up in this test's window and reads as a spurious restart. That produced a
	# false FAIL here on 2026-08-25 and the code was correct all along.
	sleep 10
	: > /tmp/mwan3-calls.log
	# A settings edit IS a uci commit, so the trigger this fires is the thing
	# under test. No explicit reload: that would test a path a user never takes.
	uci set wansentry.main.down=4; uci commit wansentry
	sleep 10
	if grep -q ' restart' /tmp/mwan3-calls.log; then
		bad "an ordinary settings edit must not restart an armed mwan3"
	else
		ok "an ordinary settings edit does not restart an armed mwan3"
	fi

	uci -q delete mwan3.wan.track_ip; uci add_list mwan3.wan.track_ip=192.0.2.1
	uci commit mwan3; /etc/init.d/mwan3.real restart >/dev/null 2>&1; sleep 45
	sleep 10
	: > /tmp/mwan3-calls.log
	uci set wansentry.main.down=5; uci commit wansentry
	sleep 10
	if grep -q ' restart' /tmp/mwan3-calls.log; then
		bad "a reload during a DUAL OUTAGE must not restart mwan3"
	else
		ok "a reload during a dual outage does not restart mwan3"
	fi

	uci -q delete mwan3.wansentry_fail; uci commit mwan3
	/etc/init.d/mwan3.real restart >/dev/null 2>&1; sleep 20
	sleep 10
	: > /tmp/mwan3-calls.log
	/etc/init.d/wansentry reload; sleep 10
	if grep -q ' restart' /tmp/mwan3-calls.log; then
		ok "an UNARMED mwan3 is restarted (the original bug stays caught)"
	else
		bad "an unarmed mwan3 must be restarted"
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
	    "2 YES" "$(symlinks) $(running)"

	echo "option broken 'unterminated" >> /etc/config/mwan3
	chk "a PARSE ERROR is reported as unreadable, not as empty" \
	    "UNREADABLE" "$(gate)"
	/etc/init.d/wansentry start >/dev/null 2>&1; sleep 4
	chk "a parse error must NOT stop or disable a foreign mwan3" \
	    "2 YES" "$(symlinks) $(running)"

	cp "$BK/hand" /etc/config/mwan3
	/etc/init.d/mwan3 enable >/dev/null 2>&1
	mv /etc/config/mwan3 "$BK/away"
	chk "a MISSING FILE is reported as unreadable, not as empty" \
	    "UNREADABLE" "$(gate)"
	/etc/init.d/wansentry start >/dev/null 2>&1; sleep 4
	chk "a missing config must NOT stop or disable a foreign mwan3" \
	    "2 YES" "$(symlinks) $(running)"
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
	    "1 NO" "$(symlinks) $(running)"

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
