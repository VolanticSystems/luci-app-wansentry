# luci-app-wansentry

**Dual-WAN failover on OpenWrt, in one screen and about five minutes.**

`wansentry` does not implement failover. It *generates* the mwan3 configuration
that implements failover, from nine fields on a single LuCI page, and then owns
what it generated. Pick a primary uplink, pick a backup, name two health-check
hosts, apply. Provided both uplinks already exist as configured network
interfaces, nothing else has to be visited.

> Status: **working, published as a demonstration project.** Developed and
> tested on real hardware, including config generation, ownership refusal,
> rollback and service reconciliation. **Not** yet tested with a genuinely live
> second uplink: an actual switchover under load is unverified, so treat this as
> a reference implementation rather than something to put in front of an uplink
> you depend on. See *Known limitations*.

## Why

mwan3 is the right engine for this. It is actively maintained, and every sharp
edge in dual-WAN failover — probe hysteresis, multi-target tracking, conntrack
flushing on switchover, hotplug integration — is something it has already
iterated on for a decade. That is not the problem.

The problem is that mwan3 is a *general* policy-routing tool, and its LuCI app
exposes that generality: separate configuration tabs for Interfaces,
Members, Policies and Rules, plus globals, and further tabs for status. A pure failover setup needs six
sections across five of those screens, and none of the concepts it makes you
learn are ones you asked about. The recurring forum complaint is not that mwan3
does not work; it is that the documentation is "huge and complex" for what
people consider a basic two-uplink job.

Several projects have answered that by reimplementing failover from scratch,
starting around 2010: `simplefailover`, `Adze1502/mwan`,
`GTANAdam/openwrt-wan-failover-script`, `belliash/wanmonitor` and others. Most
are now unmaintained, and the one adjacent tool with real traction,
`br101/pingcheck`, does detection only and deliberately leaves failover to
something else. Dates and current status for each are tabulated in
[docs/DESIGN.md](docs/DESIGN.md) section 2, so you can check that reading
rather than take it on trust.

The conclusion wansentry draws from that history is that the gap worth filling
is a simpler *configuration* path onto mwan3, not another failover mechanism.
That is a judgement, not a measurement, and it is the premise the whole
package rests on.

## How it compares

| | `luci-app-mwan3` | `luci-app-wansentry` |
|---|---|---|
| Scope | Every mwan3 feature: load balancing, weights, arbitrary policies and rules | Failover only: one primary, one backup |
| Screens for a working setup | Several: Interfaces, Members, Policies, Rules, plus status | 1 |
| Fields | Every mwan3 option, on every section | 9 |
| Configuration model | You write mwan3 config | wansentry generates it, and shows you exactly what it wrote |
| Backend | mwan3 | mwan3 (same engine, same package) |
| Coexistence | It *is* the mwan3 editor | Refuses to touch mwan3 config it did not create |

They are not really competitors. Use wansentry to get failover working; if you
later need load balancing or per-destination policies, install
`luci-app-mwan3`, and wansentry will step aside the moment it sees a section it
did not write.

## What it generates

Two `interface` sections (tracking options mapped from the form), two `member`
sections at metric 1 and 2, one failover `policy`, and one default `rule` — the
complete minimal mwan3 failover configuration and not one section more.
The only exception is mwan3's own `globals` section, which wansentry adds
(with `mmx_mask`) if and only if the system does not already have one; a
stock mwan3 install ships it, so normally nothing is added. The
screen renders the exact text before you apply it. Regeneration is idempotent:
applying an unchanged configuration produces zero uci operations.

## Opinions it holds

- **Any one health-check host answering keeps an uplink up.** ICMP-hostile
  upstreams are common; demanding that every target respond turns one of them
  into a phantom outage.
- **Recovery is slower than failure.** The recovery threshold defaults higher
  than the failure threshold, because flapping back onto a shaky primary is
  worse than staying on a working backup a little longer.
- **Conntrack is flushed on every transition by default.** Established
  connections carry per-flow NAT and routing-mark state that still points at
  the uplink that just failed; until those entries expire they keep steering
  traffic down the dead path, so they are cleared on the switch.
- **If both uplinks are marked offline, traffic falls through to the kernel
  routing table** rather than being blackholed. A tracking false positive
  should degrade to plain routing, not to a total outage.
- **IPv4 only in v1.** IPv6 failover does not move on a default-route metric,
  and pretending otherwise does not solve it.

Each of these is argued, with sources, in [docs/DESIGN.md](docs/DESIGN.md).

## What it does not solve

DNS. dnsmasq merges upstream resolvers from every interface that is up and
picks between them without regard to failover state, so name resolution can
still be attempted through the uplink that just died. mwan3 does not solve this
either. wansentry shows the failure mode and the dnsmasq workaround on screen
rather than pretending the problem does not exist.

## Install

**This package is not in the official OpenWrt feeds**, so there is no one-line
install from a stock device. Build it with the OpenWrt SDK for your release and
architecture, then install the resulting package.

Build:

    # from an OpenWrt SDK tree matching your device's release
    ./scripts/feeds update -a
    ./scripts/feeds install -a
    git clone https://github.com/VolanticSystems/luci-app-wansentry.git \
        package/luci-app-wansentry
    make package/luci-app-wansentry/compile V=s

Install on the device (copy the built package over first):

    apk add --allow-untrusted /tmp/luci-app-wansentry-*.apk   # pulls in mwan3

`--allow-untrusted` is required because a locally built package is not signed
by an OpenWrt repository key. On releases still using opkg, use
`opkg install ./luci-app-wansentry_*.ipk` instead.

Then **Network → WAN Failover**.

## Known limitations

Documented up front rather than left to be discovered.

- **IPv4 only.** wansentry generates no IPv6 failover configuration. On a
  dual-stack network IPv6 traffic is unaffected by a failover and will continue
  to use the failed uplink's route until that route goes away. mwan3 itself can
  express IPv6 rules; wansentry deliberately does not generate them in v1,
  because IPv6 failover does not reduce to a default-route metric and doing it
  badly is worse than not doing it.
- **A live switchover under load has not been tested.** Config generation,
  the ownership model, rollback behaviour and service reconciliation are all
  verified on hardware, but the development bench had only one real uplink, so
  the end-to-end event this package exists to handle (a primary WAN failing
  while traffic is flowing) is unverified. This is the reason for the status
  note above.
- **DNS is not solved, and cannot be solved here.** dnsmasq merges upstream
  resolvers from every interface that is up and does not consult failover
  state, so name resolution can still be attempted through a dead uplink.
  mwan3 has the same gap. wansentry surfaces the failure mode and the dnsmasq
  workaround on screen instead of pretending otherwise.
- **Failover only, by design.** No load balancing, no per-destination policy
  routing. If you need those, use mwan3 directly; wansentry deliberately
  refuses to grow into a second mwan3 UI.
- **wansentry only touches what it created.** It will not modify or remove
  mwan3 configuration it did not generate, and the service-side reconciler
  applies the same rule. An existing hand-built mwan3 setup is left alone, and
  wansentry will decline to manage it rather than adopt it.

## License

Apache-2.0 — see [LICENSE](LICENSE).
