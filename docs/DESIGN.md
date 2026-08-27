# wansentry — Design

Status: v1 spec LOCKED (2026-08-21). Remaining open items tracked in §9.

## 1. Goal

One LuCI screen that turns "this uplink normally, that one when it breaks" into
a complete, correct mwan3 configuration, for a technical hobbyist who reads
config files and does not want to learn mwan3's policy-routing model to get
two-uplink failover.

Primary scope (v1): **IPv4 failover between exactly two netifd interfaces**.
Explicit non-goals for v1: load balancing, more than two uplinks,
per-destination policies, IPv6 (§7.2), automatic DNS remediation (§7.1).

## 2. Verdict: generate mwan3, do not build a daemon

This is the load-bearing decision, and it went against the initial instinct.

The complaint that motivates this package is a UX complaint, not a functional
one. mwan3 works. `luci-app-mwan3` exposes six configuration tabs and four
status tabs because mwan3 is a general policy-routing engine, and a pure
failover user must still assemble six sections across five of those screens
while reading about Members, Policies and Rules they will never vary. Forum
threads describe the documentation as "huge and complex" for a basic two-WAN
job and the extra default fields as "distracting".

The tempting response — a small health-check daemon that flips a default route
metric — has been tried repeatedly:

| Project | Fate |
|---|---|
| `simplefailover` (eko.one.pl) | Changelog 2010–2017, never entered the official feed, cannot handle interfaces that disappear (PPPoE, mobile), does not touch conntrack or DNS |
| `Adze1502/mwan` | 84 stars, archived by its owner 2017-12-29 |
| `GTANAdam/openwrt-wan-failover-script` | 1 star |
| `aleks-o/WFS`, `belliash/wanmonitor`, `jeverley/wanmonitor` | No meaningful adoption; `belliash`'s README exists specifically to explain why the two before it were not enough |
| `br101/pingcheck` | 57 stars — the one success, and it does **detection only** and deliberately refuses to own failover |

Fifteen years, at least six attempts, one survivor, and the survivor won by
*not* doing the thing the others tried to do. That is a graveyard, and the
shape of it is informative: the ecosystem does not want another failover
mechanism, it wants a better front end for the one that works.

The mechanism argument points the same way. Every sharp edge in §7 is something
mwan3 has partial or full tooling for and a from-scratch daemon would have to
rediscover: `flush_conntrack` plus a documented hotplug hook point, multi-target
tracking with `reliability`/`count`/`interval` hysteresis, several probe methods
for ICMP-hostile upstreams. mwan3 is at 2.12.x with commits into mid-2026 from
multiple contributors. A bespoke daemon would put 100% of that surface, IPv6
included, on one maintainer with no upstream to share fixes with.

So: **wansentry generates mwan3 configuration and owns what it generated.** It
ships no daemon, no route manipulation and no health checking of its own.

The obligation that comes with that verdict: the generator has to be genuinely
opinionated. A friendlier label on the same six tabs would not solve the
complaint the forum threads describe. Nine fields, one screen, and mwan3's
Members/Policies/Rules never surfaced at all.

## 3. Ground truth (verified on hardware, 2026-08-21)

Test platform: Linksys EA8500, OpenWrt 25.12.5 (r33051), LuCI 26.180.75667,
mwan3 **2.12.0-r3**, arch `arm_cortex-a15_neon-vfpv4`. Second uplink `wanb`
defined on `lan4` with no cable, so it is permanently down — which is exactly
the state a backup uplink is in most of the time.

### 3.1 mwan3 status is on ubus, not a file

`/usr/share/rpcd/ucode/mwan3` registers a `mwan3` ubus object with a single
`status` method taking `section` and `interface`. Sections: `interfaces`,
`connected`, `policies`; omitting `section` returns all three.

- `interfaces.<name>` carries `status` (online/offline/disabled/unknown),
  `enabled`, `running`, `tracking` (active/paused/down/disabled), `up`,
  `uptime`, `age`, `online`, `offline`, `score`, `lost`, `turn`, and a
  `track_ip[]` array of `{ip, status, latency, packetloss}`.
- `policies.ipv4.<policy>` is an array of `{interface, percent}` **read back
  out of the live iptables chains**. This is the authoritative answer to "which
  uplink is carrying traffic right now", and an empty result means the policy
  is not installed at all — the service is stopped or was never applied.

`latency`/`packetloss` are only populated when `check_quality` is enabled;
mwan3track writes those files only on the quality code path. wansentry does not
enable `check_quality`, so the status panel shows those two columns **only when
mwan3 actually reports non-zero values** rather than rendering two permanently
empty columns.

### 3.2 mwan3 option names that matter (read from 2.12.0 source, not docs)

Interface section, from `mwan3track`: `enabled`, `family`, `track_ip` (list),
`track_method`, `reliability`, `count`, `timeout`, `interval`, `down`, `up`,
`size`, `max_ttl`, `failure_interval`, `recovery_interval`,
`keep_failure_interval`, `check_quality`, `failure_latency`,
`recovery_latency`, `failure_loss`, `recovery_loss`, `initial_state`.

Two findings that shaped the generated config:

- **`flush_conntrack` is a list of hotplug actions, not a boolean.** Valid
  values are `ifup`, `ifdown`, `connected`, `disconnected`
  (`/etc/hotplug.d/iface/15-mwan3` ends with `mwan3_flush_conntrack "$INTERFACE"
  "$ACTION"`). wansentry writes all four when the toggle is on.
- **Policy and rule names are truncated at 15 characters.** `mwan3.sh` compares
  `"$1"` against `$(echo "$1" | cut -c1-15)` in both `mwan3_create_policies_iptables`
  and the rule handler, and *silently skips the section* if it is longer. Hence
  `wansentry_fail` (14) and `wansentry_def` (13) rather than the readable full
  words. Member names have no such limit.

`last_resort` accepts `unreachable` (mwan3's default), `blackhole` or
`default`.

### 3.3 mwan3 reloads itself on commit

`/etc/init.d/mwan3` declares `procd_add_reload_trigger 'mwan3'`, so committing
`/etc/config/mwan3` reloads the service with no explicit action — *provided the
service is running*, because procd deregisters the trigger when it stops. That
asymmetry drives the ordering in §6.4.

## 4. Architecture

    LuCI view (overview.js)
        │  form.Map over /etc/config/wansentry  — the 9 fields
        ▼
    generator.js  — pure model: settings -> desired mwan3 sections
        │  uci.add / uci.set / uci.remove   (LuCI uci JS API only)
        ▼
    /etc/config/mwan3
        │  procd reload trigger
        ▼
    mwan3 2.12.x

No file is written by hand, no template is rendered, and nothing in this
package runs a shell — with exactly one exception, `logread -l 200 -e mwan3` for the
event list (§5.3), which has no ubus equivalent.

Three source files:

| File | Responsibility |
|---|---|
| `common.js` | ubus bindings, log tail and parser, CSS, small DOM primitives |
| `generator.js` | the mwan3 model, ownership classification, idempotent write, preview rendering |
| `overview.js` | the single view: banners, status panel, form, preview, limitations, apply orchestration |

`generator.js` is deliberately free of DOM: it is the part worth reasoning
about in isolation.

## 5. UI specification

One menu entry, `Network → WAN Failover`. Top to bottom:

1. **Banners** — blocking or qualifying conditions only (§6.3, §6.5).
2. **Failover status**, polled every 5 s: which uplink is carrying traffic
   (from `policies.ipv4.wansentry_fail`), two uplink lanes with tracking state,
   probe state, link uptime, time in current state, score/lost and the
   per-host probe table, then the recent transition list.
3. **The nine fields.** Enable, primary, backup, health-check hosts, check
   interval, failure threshold, recovery threshold, return-to-primary, flush
   conntrack. Nothing else.
4. **Generated mwan3 configuration** — the exact text that will land in
   `/etc/config/mwan3`, rendered from the same model the writer uses. A
   generator whose output you cannot audit is a black box, and the audience for
   this package reads config files.
5. **Known limitations in v1** — DNS, IPv6, flow offloading, stated plainly
   with the workaround where one exists.

### 5.3 Event list

mwan3 logs one line per transition via `logger -t mwan3track`:
`Interface wan (wan) is online`. There is no ubus object for the system log, so
this is the one place the app shells out, through `fs.exec('/sbin/logread',
['-l','200','-e','mwan3'])`, with the ACL granting exec on exactly that command
string and nothing else. If the ACL is missing the panel renders an
explanatory empty state rather than breaking.

## 6. The generated configuration

### 6.1 What is written

For primary `P` and backup `B`:

    config interface 'P'            # and 'B', identical apart from nothing
        option wansentry '1'
        option enabled '1'          # '0' when the master toggle is off
        option family 'ipv4'
        option initial_state 'online'
        option track_method 'ping'
        list   track_ip <each health-check host>
        option reliability '1'
        option count '1'
        option timeout <min(4, interval-1)>
        option interval <check interval>
        option failure_interval <check interval>
        option recovery_interval <check interval>
        option down <failure threshold>
        option up <recovery threshold>
        list   flush_conntrack 'ifdown' 'disconnected' 'ifup' 'connected'

    config member 'wansentry_primary'   interface P, metric 1, weight 1
    config member 'wansentry_backup'    interface B, metric 2, weight 1

    config policy 'wansentry_fail'      use_member both, last_resort 'default'

    config rule 'wansentry_def'         dest_ip 0.0.0.0/0, family ipv4,
                                        use_policy wansentry_fail, sticky 0

`globals` is created with mwan3's own `mmx_mask` only if it is missing
entirely; wansentry never edits an existing one.

### 6.2 Why those values

- **`reliability 1`** — an uplink is up when *any one* health-check host
  answers. Some upstreams filter or rate-limit ICMP; requiring all targets to
  respond converts one such host into a phantom outage. This is the specific
  reason `pingcheck` supports non-ICMP probes, and the reason the field help
  tells you to pick two hosts on different operators.
- **`timeout = min(4, interval - 1)`** — mwan3 needs the per-probe timeout
  below the check interval or a slow probe overlaps the next check. At the
  default 5 s interval this is 4 s.
- **Recovery threshold defaults above the failure threshold** (6 vs 3). Failing
  over costs one conntrack flush; failing back onto a primary that is still
  flapping costs one per flap.
- **`last_resort 'default'`** — if both uplinks are marked offline, fall
  through to the kernel routing table rather than mwan3's default of
  `unreachable`. Blackholing is the right answer for a load balancer that must
  not leak traffic; for a home failover box, a tracking false positive should
  degrade to ordinary routing, not to a total outage.
- **`weight 1` on both members** — weight only matters between members at the
  *same* metric. Different metrics is what makes this failover rather than load
  balancing, so the weights are inert and set to the least surprising value.
- **No `size`, `max_ttl`, `check_quality`** — pure mwan3 defaults that the form
  does not control. Everything the form *does* control is written explicitly,
  even where it matches the default (`reliability`, `count`), so the generated
  file states its intent rather than relying on mwan3's defaults not moving.

### 6.3 Ownership model

The rules, in the order they are evaluated per section. **The order is
load-bearing and rule 0 comes first:**

0. **Type gate.** If the section's type is not one of `interface`, `member`,
   `policy` or `rule`, it is **foreign immediately** and rules 1 and 2 are
   never consulted. wansentry generates only those four types, so a section of
   any other type is by definition something it did not write, whatever it is
   called and whatever options it carries.
1. **Owned** — the section passed rule 0 *and* carries `option wansentry '1'`,
   or its name begins with `wansentry_`. wansentry writes and deletes these
   freely.
2. **Stock scaffolding** — the section is byte-identical to one the mwan3
   package ships in its default `/etc/config/mwan3` (22 sections: the
   wan/wanb/balanced example). Package scaffolding is not configuration;
   wansentry deletes it on first apply.
3. **Foreign** — anything else. wansentry refuses to apply *at all*, marks the
   whole form read-only, and names the offending sections in a banner. It does
   not merge, reconcile or "fix" a configuration a human wrote.

**Rule 0 was implicit until 2026-08-26 and that is exactly how the two
implementations drifted.** `audit()` in the browser has always tested the type
first, but this section did not say so, and the service-side reconciler was
written from this text. It therefore matched the marker and the namespace on
name alone. A `config notify` section named `wansentry_notify` was foreign in
the browser and owned on the router, and since `enabled 0` is the shipped
default the reconciler stopped and disabled it. Reproduced on hardware by
`tests/ownership-suite.sh`: the identical section under an ordinary name was
correctly left alone, and only the rename flipped the outcome.

That is the third disagreement between these two counts, and all three pointed
the same way, at tearing down configuration this package did not write. The
lesson is not "be careful", it is that **a rule implemented twice needs a test
that drives both implementations against the same fixtures**, which is what
that suite now is.

`globals` is exempt from all three: it is mwan3's own infrastructure, never
owned and never foreign.

Two consequences worth stating out loud:

- **mwan3 interface sections cannot be renamed.** mwan3 looks up
  `network.interface.<section name>` on ubus, so the section for the primary
  uplink *must* be called `wan` if that is the netifd interface. The
  `wansentry_` prefix therefore only applies to members, the policy and the
  rule; interface sections are marked with the `wansentry` option instead.
- **Rule 2 compares values, not just names.** A user configuring mwan3 through
  `luci-app-mwan3` edits exactly those stock sections, so name matching alone
  would silently destroy a real configuration. The fingerprint is the full
  option set of each section.

Rule 2 fails safe. If a future mwan3 release changes its shipped defaults, the
sections stop matching, get classified foreign, and wansentry refuses instead
of deleting something it does not understand. The banner says so, so the user
is not left guessing why the screen is read-only.

### 6.4 Apply ordering

Save and Apply, in order:

1. `form.Map.save()` — writes `/etc/config/wansentry` into uci's pending set.
   (Both refusal checks run *before* this so the save is all-or-nothing: the
   foreign-config check, and `validate()` against the live widget values via
   `liveSettings()`. `validate()` had to be hoisted too because it can fail on
   a two-click mistake, identical or empty interfaces, and running it after
   `map.save()` staged would leave `/etc/config/wansentry` half-committed while
   telling the user the save was refused.)
2. `generator.write()` — reads those pending values straight back and stages
   the mwan3 sections alongside them. Throws on foreign config or invalid
   input; the error surfaces as a notification and nothing is committed.
3. `uci.save()` — pushes the mwan3 changes to the server's staging area. Easy
   to forget: `form.Map.save()` only pushes its own.
4. `ui.changes.apply(true)` — hands the commit to LuCI's own apply flow, which
   owns the rollback-protected commit, the confirm countdown, and the reload,
   all driven from this document. A manual `uci.apply().then(reload)` races the
   confirm (uci.apply resolves before the +1000 ms confirm is scheduled, and the
   reload cancels it, so rpcd silently rolls the config back ~90 s later); using
   LuCI's own flow avoids that entirely.

**The browser never touches init scripts.** Service enable/disable is *not* done
from the apply handler. `/etc/init.d/mwan3 enable|disable` writes `/etc/rc.d`
symlinks, which UCI's rollback snapshot does **not** cover (rollback reverts only
`/etc/config`). Doing the enable/disable in the browser, before or after the
transactional commit, could therefore leave the service state and the config
disagreeing if the apply is rolled back — for a failover package, the worst
outcome is exactly that: config says enabled, service disabled, failover
silently unarmed after the next reboot. Instead a tiny router-side init script,
`/etc/init.d/wansentry`, reconciles the mwan3 service (enable + start, or stop +
disable) to the committed `wansentry.enabled`, on the wansentry reload trigger
and again at boot. A rollback re-fires the trigger with the reverted config and
the service follows it, so the two can never diverge. This also means wansentry
grants **no** `luci.setInitAction` ACL: the browser has no init-control right at
all (see §8).

**The reconciler is ownership-gated, and the gate distinguishes "owns nothing"
from "someone else owns something."** The reconciler is the service-side mirror
of the generator's `isOwned()`: the generator refuses to touch mwan3 *config* it
did not write, and the service must refuse just as hard, or it would stop a
user's hand-built mwan3 at boot, since `enabled=0` is the shipped default and
that is the state before the settings page has ever been opened. It therefore
counts `owned` (sections `isOwned()` would claim: carrying
`option wansentry '1'` **or** living in the `wansentry_` namespace, counted by
name and de-duplicated) against `managed` (every mwan3 section except
`globals`) and hands off entirely, touching nothing, the moment any *foreign*
section exists.

**Both counts were wrong until 2026-08-25, in the dangerous direction, and an
adversarial panel found it.** `managed` matched only
`interface`/`member`/`policy`/`rule`. A section of any other type is classified
foreign by `audit()`, which makes the generator refuse to write at all -- but it
was invisible to the reconciler. Measured on hardware against an `/etc/config/mwan3`
holding `config globals` and `config notify`: `owned=0 managed=0 foreign=0`, so
the gate fell through to the disable branch and **stopped and disabled a
stranger's mwan3**, which is the one thing this package promises never to do.
The frontend refused to save the same config while the service tore it down.

`owned` had the mirror-image gap: it counted only the option, while `isOwned()`
also accepts the `wansentry_` name prefix, so a prefixed section without the
option read as ours in the browser and as foreign on the router. Counting names
and de-duplicating fixes both without double-counting the generated sections,
which match on both tests. Verified across four configurations on hardware.

The distinction matters in one specific case that an "owns nothing, do nothing"
gate gets wrong. A **first** enable that is rolled back leaves the config
reverted (so `owned` is zero) while the `/etc/rc.d` symlink written during the
apply window survives, because UCI rollback does not cover it. An ownership gate
keyed only on `owned > 0` would decline to act and strand an enabled, running
mwan3 with an empty configuration. Because `foreign` is separately known to be
zero there, the reconciler can safely stop and disable mwan3 in that case while
still leaving a genuinely foreign mwan3 running untouched. Both halves are
verified on hardware.

## Security audit, 2026-08-25

A carriers-only panel was asked for a security review specifically, with a
stated threat model, after two correctness rounds. Three findings, all confirmed
on hardware, all fixed. Recorded here because the first is the worst defect this
package has had.

**1. The root-side reconciler treated an unreadable mwan3 as an empty one, and
stopped and disabled it.** `uci -q show mwan3` prints nothing both when the
config is genuinely empty and when it cannot be parsed at all, and the gate is
arithmetic over that output: `owned=0 managed=0 foreign=0` takes the
stop-and-disable branch. Measured on OpenWrt 25.12.5:

| state | `uci -q show mwan3` | rc | old behaviour |
|---|---|---|---|
| valid, populated | 22 lines | 0 | correct |
| valid, empty | 0 lines | 0 | stop + disable (intended) |
| parse error | 0 lines | **1** | **stop + disable (wrong)** |
| file absent | 0 lines | **1** | **stop + disable (wrong)** |

Reproduced: a hand-configured mwan3 carrying no wansentry marker anywhere,
running with both rc.d symlinks present, was stopped and its start symlink
removed after a single unbalanced quote was appended to `/etc/config/mwan3`.
That is this package's one promise, broken by the half of it that runs as root.
It is also persistent, because repairing the file does not restore the symlink,
and it was silent, because every service call is `2>/dev/null`. Anyone able to
write that file without being root could trigger it, which turns a recoverable
corruption into a lasting one.

Fixed by reading the config once and keeping uci's exit status: a non-zero read
means unknown, and unknown is not permission, so the reconciler returns having
touched nothing and logs why. The genuinely-empty case still reaches the disable
branch, so the rolled-back-first-enable path below is unaffected. Both halves
re-tested, plus both legitimate paths as regressions.

**2. The ACL granted read of the whole `network` package.** It was used for one
thing: filtering dhcpv6 interfaces out of the dropdown by reading `proto`. But
`/etc/config/network` also holds PPPoE and 802.1x credentials and wireguard
private keys, so an administrator who restricted a user to failover settings had
also handed them every upstream secret on the router.

Removed. The filter now uses `n.getProtocol()` from LuCI's network model.
Verified sufficient rather than assumed: `enumerateNetworks()` falls back to the
netifd interface dump for anything uci did not supply, and on hardware all six
configured interfaces appear there including the ones that are down, with
`wan6` carrying `proto "dhcpv6"` -- exactly the case the filter exists for.

**3. The log-event parser could be spoofed.** `EVENT_RE` began `^(.+?)\s+\S+\s+`,
and a lazy prefix will absorb an entire real log line, so any process able to
write to syslog could put a fabricated failover event on the screen by including
the text in its own message. Verified:
`... daemon.warn dropbear[999]: mwan3track[1]: Interface wan (wan) is offline`
matched and rendered as a genuine outage. The prefix is now anchored by shape,
timestamp then facility.level. The panel drives no decision, so this is the
integrity of what an operator is shown rather than a route to privilege.

**What the audit did NOT find, which is also a result.** No command injection,
no unquoted expansion reaching a shell, no `eval`, no path traversal, and no
unauthenticated path. The reconciler parses attacker-influenced config using
only `grep`, `sed` and arithmetic, and one juror said so explicitly. The rpcd
`file exec` grant was correctly left alone by every juror this round.

**An empty audit is not permission; an unreadable mwan3 is unknown, not clean.**
`audit()` classifies what `uci.sections('mwan3')` returns, and that is `[]` both
when mwan3 holds nothing foreign and when the package never loaded --
`L.resolveDefault()` flattens a missing package, an ACL gap, a transient rpcd
failure and an unparseable `/etc/config/mwan3` into the same `null`. The last is
the dangerous one: it is exactly when a foreign hand-built config *does* exist
and the ownership check cannot see it. The screen has always blocked this
(`blocked = !mwan3Loaded || foreign.length`, driving `m.readonly`), but that is
a rendering decision, and until 2026-08-25 `handleSave()` itself consulted only
`foreign.length`. The promise is now enforced in the save path, where it
belongs, rather than depending on a variable in another function. Raised by a
carrier juror, which was also careful to flag that it could not tell whether the
button was reachable under `m.readonly`; the fix is defence in depth either way.

**Arming is decided by whether a policy is installed, not by whether traffic is
flowing.** `mwan3_armed()` exists because `/etc/init.d/mwan3 running` reports
success on an mwan3 carrying no policy at all, which is silent non-failover. It
reads `mwan3 policies`, which prints the live firewall chains back. It matches
any indented policy entry; it used to match `([0-9]+%)`, and **that was the
inverse of the bug it was written to catch**, found by the same panel and
measured on OpenWrt 25.12.5 with mwan3 2.12.0:

| state | `mwan3 policies` prints | armed? | old check | new check |
|---|---|---|---|---|
| a member online | ` wan (100%)` | yes | TRUE | TRUE |
| every uplink offline | ` default` | yes, via `last_resort` | **FALSE** | TRUE |
| no policy installed | nothing indented | no | FALSE | FALSE |

The middle row is `last_resort 'default'` doing exactly its job, and the old
check called it unarmed. `reconcile()` would then restart mwan3 on every reload
trigger during a dual outage, and at boot whenever the uplinks were not up yet,
since `START=21` runs before a WAN normally comes up. That breaks the promise
made two paragraphs above, that an ordinary settings edit never restarts an
already-armed mwan3.

**Safety net.** Even if the reconciler never runs, wansentry disabled is inert:
the generated interfaces carry `enabled '0'`, so the policy has no members, so
`last_resort 'default'` sends everything to the kernel routing table. A disabled
wansentry cannot break routing whether or not mwan3 is running.

### 6.5 Idempotency

`generator.write()` compares every option against the current value before
writing it, and unsets stale options rather than recreating sections. Applying
an unchanged configuration therefore produces **zero** uci operations, not a
no-op rewrite — verified on hardware by md5sum across two consecutive applies.

## 7. Sharp edges and how v1 handles each

### 7.1 DNS bound to a dead uplink — acknowledged, not solved

dnsmasq merges the resolvers learned from every interface that is up into one
runtime resolv file and picks between them with no notion of failover state.
After a switchover, resolution can still be attempted through the uplink that
just died, and the network looks broken even though routing is correct. This is
open against mwan3 itself in more than one issue; it is a wash between "build
on mwan3" and "build a daemon", and neither solves it.

wansentry could apply the standard workaround (`resolvfile=''`, `noresolv=1`,
fixed `server` entries) automatically. It deliberately does not: that rewrites
DNS for the entire router, and it is not a decision a failover screen should
make silently. Instead the screen states the failure mode and shows the exact
uci commands, so the choice is informed and one copy-paste away.

### 7.2 IPv6 — out of scope, and said so

IPv6 failover moves on router advertisements and DHCPv6-PD state, not on a
default-route metric. Clients keep stale addresses for minutes, Windows and
Android disagree about when to drop them, and mwan3 has several open defects in
this area. Real-world measurements put v6 failover an order of magnitude slower
than v4 on the same link.

wansentry generates `family 'ipv4'` sections and an IPv4 default rule only. Any
IPv6 default route keeps using ordinary kernel routing, untouched. Adopting the
package scaffolding removes mwan3's stock `wan6`/`wanb6` sections and its v6
default rule, which is the same statement made in config: v6 is not managed
here.

### 7.3 Conntrack on switchover — handled, with a stated limit

Routing changes on failover but conntrack entries stay pinned to the dead
gateway, and per RFC 5461 TCP treats the resulting ICMP unreachables as a soft
error, so clients retransmit into a dead path for minutes instead of
reconnecting. wansentry writes all four `flush_conntrack` actions by default.

Two caveats, both surfaced in the UI:

- mwan3's flush is **global** (`echo f > /proc/net/nf_conntrack`), so
  connections on the healthy uplink are dropped too.
- With fw4 flow offloading enabled, established flows take a kernel fast path
  that bypasses netfilter and can survive the flush entirely. The published fix
  for that is a selective, mark-aware flush hooked into `/etc/mwan3.user` on
  the `disconnected` event — about fifteen lines, and a candidate for v2 (§10).

### 7.4 Failback stickiness — what mwan3 can do

mwan3 has no "latch onto the backup" mode. The only lever is rule stickiness,
and it is source-IP and ipset-timeout based, not a matter of established versus
new connections: when sticky is on, mwan3 records a client's source IP in an
ipset the first time it matches the rule, and any packet from that IP,
established connection or brand new one, keeps matching the same member until
the ipset entry ages out after the configured idle `timeout`.

So the toggle is labelled "Return to primary when it recovers" and does exactly
what mwan3 can do: on writes `sticky '0'` (no per-client memory, so every
client's next packet is evaluated fresh against the policy and everything moves
back immediately), off writes `sticky '1'` plus a 600 s idle `timeout` (a
client that failed over keeps using the backup for up to 10 minutes after its
last matching packet; a client that has been idle longer than that, or a new
client, follows the policy back to the primary right away). The help text says
outright that "off" softens failback rather than preventing it. This is a
deliberate deviation from a plain reading of "sticky off": sticky is off in the
default configuration, and only the non-default branch turns it on.

### 7.5 ICMP-hostile upstreams — `reliability 1`, see §6.2.

### 7.6 DHCP renewal clobbering a metric'd route

A 2015-era netifd bug where lease renewal deleted every default route except
the one it was installing. Not reproduced on 25.12.5 and not confirmed present.
It is also structurally not wansentry's problem: mwan3 manages per-interface
routing tables rather than competing metrics on the main table. Noted so the
next person does not have to rediscover the thread.

## 8. Package layout

    Makefile                                    LuCI feed, PKGARCH all, +mwan3 +luci-base
    root/etc/config/wansentry                   defaults, ships disabled
    root/etc/init.d/wansentry                   reconciles mwan3 service to committed config
    root/usr/share/luci/menu.d/…json            Network -> WAN Failover
    root/usr/share/rpcd/acl.d/…json             ACL
    htdocs/…/view/wansentry/{common,generator,overview}.js
    po/templates/wansentry.pot                  string catalogue, GENERATED from source
    tests/ownership-suite.sh                    29 checks, the ownership rule on hardware
    tests/hardware-suite.sh                     22 checks, gate/arming/restart/security
    tests/generator-suite.js                    31 checks, the same rule in the browser
    tests/luci-module.js                        loads a real LuCI view module under Node

ACL grants, and why each is needed:

| Scope | Grant | For |
|---|---|---|
| uci read | `wansentry`, `mwan3` | the form and the generator |
| uci write | `wansentry`, `mwan3` | the two configs it owns |
| ubus read | `mwan3.status` | the status panel |
| ubus read | `file.exec` + `/sbin/logread -l 200 -e mwan3` | the event list, that exact command only |
| ubus read | `luci-rpc.getNetworkDevices`, `network.interface.dump` | interface picker |

Notably absent: any grant on `firewall`, `dhcp` or `system`, and — deliberately —
**no `luci.setInitAction`**. wansentry does not touch DNS (§7.1), has no reason to
read the firewall, and the browser never controls an init script.

**No init-control right, by design.** rpcd's `luci.setInitAction` has no
per-script granularity: granting it would give service control over *every* init
script on the router. An earlier build did grant it (to enable/disable mwan3 from
the apply handler) and this doc previously recorded that breadth as an accepted
limitation. It is no longer granted: service state is reconciled router-side by
`/etc/init.d/wansentry` from the committed config (§6.4), so the browser needs no
init right at all. Every grant that remains is scoped exactly to `wansentry`,
`mwan3`, `network`, or one literal command string.

## 9. Risks / open items

1. **Stock fingerprint drift.** If mwan3 changes its shipped defaults, first
   apply on a fresh install shows the foreign-config banner instead of adopting
   silently. Safe direction, mildly annoying; the banner names the cause.
   Revisit each mwan3 minor release.
2. **`wansentry` as an option name inside mwan3 sections.** Harmless today —
   mwan3's shell config parser ignores unknown options — but it is squatting in
   someone else's namespace. Rename to something clearly vendored if upstream
   ever grows a conflicting option.
3. **The rule is unconditional.** `dest_ip 0.0.0.0/0` means every IPv4 flow
   goes through the policy. Correct for v1's scope, and the reason there is no
   "exclude these destinations" field, but it is the first thing anyone with a
   VPN or a LAN-to-LAN route will ask for.
4. **Backup uplink health is only as good as the probe.** wansentry does not
   check that the backup interface actually has a gateway, only that mwan3
   reports what it reports. An unplugged backup shows as
   `tracking disabled / paused`, which is accurate but not loud.
5. ~~**Not tested with a genuinely live second uplink.**~~ **CLOSED
   2026-08-24.** This entry was written when all hardware testing used a backup
   that was permanently down, and it went stale the day switchover was actually
   measured. It is struck through rather than deleted because it was wrong in
   the most damaging way a document can be: the README's headline credibility
   claim pointed at a design document that contradicted it, and the first thing
   a sceptic on a public forum does is follow that link.

   What was actually done: failover was verified twice under load, on two
   independent uplink types — a wired primary failing over to USB cellular
   tethering, and the same primary failing over to a second broadband line
   reached over Wi-Fi. **13-14 s to switch against a 15 s threshold, 31 s to
   fail back against 30 s**, confirmed with interface byte counters rather than
   status output, so the traffic demonstrably moved and demonstrably came back.
   A reconciler defect was found and fixed on the way, see §6.4.

   Surfaced by a review panel asked to outline a forum announcement, which
   noticed the two documents disagreed and correctly refused to guess which was
   current.

## 10. Roadmap (queued, post-v1)

- Selective conntrack flush hook in `/etc/mwan3.user`, marked to the failed
  uplink only, so flow offloading stops defeating §7.3.
- Optional DNS remediation as an explicit, reversible toggle rather than a
  copy-paste block.
- A "test failover" button: administratively down the primary, watch the status
  panel switch, bring it back.
- IPv6 as a second, separately-tracked policy once mwan3's v6 defects settle.

## 11. Coexisting with policy-based routing and VPNs

> **Operator-facing guidance lives in [VPN-AND-POLICY-ROUTING.md](VPN-AND-POLICY-ROUTING.md).**
> This section is the engineering rationale: why the design is what it is, and
> what was measured to decide it. The other page is what to do about it on a
> router, including recipes for measuring your own.

Everything in this section was measured on a bench that deliberately replicates
a real production router (pbr 1.2.2-r20 with `strict_enforcement '1'`,
openvpn-openssl 2.7.6, mwan3 2.12.0-r3, two genuinely independent uplinks)
rather than a clean two-WAN rig. A clean rig cannot reproduce any of it. Dates
and figures are from 2026-08-27; the raw working is in
`PBR-MWAN3-BENCH-2026-08-27.md` in the parent repository.

Two predictions made before the bench existed were **wrong**, and both are
recorded here rather than quietly dropped, because the wrong version is the one
a reader is likely to arrive with.

### 11.1 The fwmark collision that does not exist

The obvious worry is that pbr and mwan3 both mark packets and will corrupt each
other. They do not:

```
pbr    masks on 0x00ff0000    ip rules at priority 29995-30000
mwan3  masks on 0x00003f00    ip rules at priority  1001-3002
```

The bit ranges are disjoint. Both marks sit on the same packet quite happily and
no `mmx_mask` retuning is needed. **Predicted collision: none.**

### 11.2 The real defect: mwan3 silently overrides pbr

What collides is not the marks but the **ip rule priorities**. Rule evaluation
is ascending, so mwan3's tables are consulted roughly 28,000 priorities before
pbr's, and pbr's decision never runs.

Measured with `ip route get`, which performs a real FIB lookup through the real
rule chain:

```
mark 0x050000  (pbr policy only)   ->  dev tun0  table pbr_vpnusa
mark 0x000100  (mwan3 uplink only) ->  dev wan   table 1
mark 0x050100  (both set)          ->  dev wan   table 1      <- pbr lost
```

and confirmed end to end with real forwarded traffic from a LAN client, using
the conntrack reply tuple to read back which uplink actually performed the SNAT:

```
no exclusion   client inside a pbr policy range  ->  192.168.72.10   plain WAN
exclusion      same client                       ->  10.48.0.2       the tunnel
```

**Why this matters more than an ordinary bug.** Nothing breaks. Traffic keeps
flowing, both packages report success, and neither logs anything. The traffic
simply stops going where the operator sent it. On a router using pbr for a
country exit, the affected devices quietly begin appearing in the wrong country.
A failure that presents as success is worth more care than one that presents as
an outage.

### 11.3 The fix, and why it is a seam rather than a workaround

For every source or destination range an enabled pbr policy claims, the
generator emits an mwan3 rule carrying `use_policy 'default'`, ordered ahead of
the catch-all:

```
config rule 'wansentry_pbr1'
	option src_ip '192.168.72.128/25'
	option use_policy 'default'
	option family 'ipv4'
	option wansentry '1'
```

`default` is mwan3's own escape hatch: it stamps only the no-op mark `0x3f00`,
which matches none of mwan3's own ip rules, so evaluation falls through to pbr's
at 29996 and the policy survives.

The division of labour this produces is the correct one, not a compromise:

- **pbr decides which traffic enters the tunnel.**
- **mwan3 decides which uplink the tunnel's own packets ride on.**

The tunnel's outer packets are router-originated and therefore outside any
sensible pbr source range, which is exactly why they still follow failover while
the policied traffic does not. Traffic outside pbr's ranges is untouched and
fails over normally; the bench asserts that with a control client.

**Rule order is load-bearing.** mwan3 evaluates rules in file order and stops at
the first match, so an exclusion behind the catch-all can never fire. `uci.add`
appends, so an exclusion created on a later apply would land there. `write()`
therefore drops and recreates the owned rule sections whenever their order is
wrong, and only then, so an unchanged re-apply still costs zero uci operations.

**A policy claiming everything is refused, not approximated.** A pbr policy that
matches on neither a source nor a destination address claims all traffic. An
mwan3 rule mirroring it would match every packet on the router, including the
tunnel's own, and switch failover off while appearing to configure it. Those
policies are skipped and named on screen instead.

**This rests on someone else's numbers.** The priorities above belong to pbr and
mwan3, not to this package. A release that renumbers them would invalidate the
mechanism silently: the generated config would still look right and still apply
cleanly. `tests/hardware-suite.sh pbr` therefore asserts the premise directly,
and it is the most important check in that file.

### 11.4 The VPN restart that turned out to be unnecessary

The intended centrepiece of this work was a nominated tunnel-restart hook. The
reasoning was sound and the conclusion was wrong.

The server pushes `Timers: ping 10, ping-restart 120`, and `route_nopull` does
not block pushed keepalive, so that timer is real. The prediction was up to two
minutes of blackout after a switchover. Measured over two failure modes, with
200-second observation windows sampling the whole stack once per iteration:

| failure mode | samples | lost | outage | tunnel restarted? |
|---|---|---|---|---|
| `ifdown wan`, link gone | 101 | 0 | none measurable | no |
| upstream blackholed, link up | 98 | 5 | ~10 s | no |

In both cases the OpenVPN process kept its PID and logged nothing. The
explanation is in the handshake:

```
peer-id: 0
protocol-flags cc-exit tls-ekm dyn-tls-crypt
```

OpenVPN 2.7 identifies a session by peer-id rather than by source address, so a
`nobind` client roams to the new uplink's address mid-session without
renegotiating. `ping-restart` never fires because nothing ever restarts.

The residual ~10 s is **mwan3's own detection time** (`interval` x `down`), not
the tunnel's, and it is tunable by the failover settings and by nothing else.

**So the feature was retired before it shipped.** A restart on every switchover
would have been a disruptive action fixing a problem that does not occur. What
ships instead is section 11.5.

The caveats bound the claim honestly: this is OpenVPN 2.7 with peer-id
negotiated against a server that supports it. OpenVPN 2.4/2.5, a server without
float, and WireGuard are all plausibly different and **none of them has been
measured here.**

### 11.5 Switchover hooks

`/etc/hotplug.d/iface/99-wansentry` runs every executable in
`/etc/wansentry.d/` when the active uplink changes, and at no other time. The
directory ships with only a README, and the script exits before doing any work
when it finds nothing executable in it.

Each hook is given `WANSENTRY_OLD`, `WANSENTRY_NEW` and `WANSENTRY_EVENT`, runs
as root, and is logged and ignored if it fails so a broken hook cannot hold up
the rest of a switchover. Repeated events that do not change the active uplink
run nothing, and a switchover within `DEBOUNCE` seconds of the previous one is
logged and skipped so a flapping primary cannot thrash whatever the hooks touch.
Note that failback means an ordinary single outage fires the hooks twice, once
each way; that is intended.

**Why a hook directory and not a list of services in the web UI.** A settings
field naming a command to run on switchover is remote command execution handed
to whoever holds the failover ACL, and a dropdown of every init script on the
box is the same thing wearing a hat: `/etc/init.d/firewall stop` is on that
list. Writing to `/etc/wansentry.d/` already requires root, so the hook
directory adds no privilege the operator did not already have.

The measurement in 11.4 is also the argument for the shape. The obvious use
turned out not to be needed, and the cases that might need it (older OpenVPN,
WireGuard, ddns, an SQM instance bound to a device) are all unmeasured. Shipping
the seam and documenting it is honest; shipping a menu of guesses is not.

### 11.6 Interface roles

The settings screen used to offer every interface except loopback and the
IPv6-only companions. On a router with a VPN and a few bridges that means `lan`
and `vpnusa` are offered as candidates for "primary uplink", neither of which
can work, with nothing on screen saying so.

The instinct behind the old behaviour was right and its conclusion was not.
An LTE stick, a tethered phone and a neighbour's wifi joined as a station are
all legitimate backups and none of them looks like a "wan", so guessing by NAME
would indeed be wrong. But refusing to guess by name does not mean offering
everything; it means classifying by evidence. Protocol, device and gateway give
four roles:

| role | evidence | offered by default |
|---|---|---|
| uplink | up, and has a gateway | yes |
| tunnel | tunnel protocol, or a `tun`/`tap`/`wg` device | no |
| local | up with no gateway, or a bridge that is down | no |
| unknown | down, and not obviously a bridge | yes |

`unknown` is offered deliberately. It is the LTE stick that is not plugged in,
and hiding it would make the classifier's mistakes into the user's dead end.

A `tun`/`tap`/`wg` **device** test sits alongside the protocol test because
OpenVPN on OpenWrt is commonly wired up as `proto none` over `tun0`, which no
protocol check would ever catch. That is how the reference production router is
configured.

Nothing is hidden. `show_all_interfaces` lists everything with the reason
attached, and it is forced on when fewer than two interfaces look like uplinks
or when a saved selection is one the screen would not otherwise offer, so a
stored setting can never become unselectable. The classifier can be wrong, most
obviously for an ISP that delivers the uplink over a tunnel, and the toggle is
the way past that.

### 11.7 What is still unmeasured

Stated plainly so nobody mistakes silence for coverage:

- WireGuard across a switchover. Expected to re-handshake within seconds, not
  tested.
- OpenVPN 2.4/2.5, or any server that does not negotiate peer-id.
- pbr with `strict_enforcement '0'`, where a policy whose interface is down
  falls through to the main table instead of refusing.
- IPv6 throughout. pbr was configured `ipv6_enabled '0'` on the bench, matching
  the reference router, and this package generates IPv4 policy only.
- More than one pbr policy set overlapping in ways that produce contradictory
  exclusions.
