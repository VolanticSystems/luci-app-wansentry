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

The rules, in the order they are evaluated per section:

1. **Owned** — the section carries `option wansentry '1'`, or its name begins
   with `wansentry_`. wansentry writes and deletes these freely.
2. **Stock scaffolding** — the section is byte-identical to one the mwan3
   package ships in its default `/etc/config/mwan3` (22 sections: the
   wan/wanb/balanced example). Package scaffolding is not configuration;
   wansentry deletes it on first apply.
3. **Foreign** — anything else. wansentry refuses to apply *at all*, marks the
   whole form read-only, and names the offending sections in a banner. It does
   not merge, reconcile or "fix" a configuration a human wrote.

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
   (A foreign-config check runs *before* this, so a refusal never leaves
   wansentry changes staged.)
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

ACL grants, and why each is needed:

| Scope | Grant | For |
|---|---|---|
| uci read | `wansentry`, `mwan3`, `network` | the form, the generator, the interface picker |
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
5. **Not tested with a genuinely live second uplink.** All hardware testing was
   with the backup permanently down (no cable). Config generation, ownership,
   idempotency and the status view are verified; an actual switchover under
   load is not.

## 10. Roadmap (queued, post-v1)

- Selective conntrack flush hook in `/etc/mwan3.user`, marked to the failed
  uplink only, so flow offloading stops defeating §7.3.
- Optional DNS remediation as an explicit, reversible toggle rather than a
  copy-paste block.
- A "test failover" button: administratively down the primary, watch the status
  panel switch, bring it back.
- IPv6 as a second, separately-tracked policy once mwan3's v6 defects settle.
