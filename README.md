# luci-app-wansentry

**Dual-WAN failover on OpenWrt, in one screen and about five minutes.**

`wansentry` does not implement failover. It *generates* the mwan3 configuration
that implements failover, from nine fields on a single LuCI page, and then owns
what it generated. Pick a primary uplink, pick a backup, name two health-check
hosts, apply. Nothing else has to be visited.

> Status: **in development** — tested on hardware, not yet released. Not yet
> tested with a genuinely live second uplink; an actual switchover under load
> is unverified.

## Why

mwan3 is the right engine for this. It is actively maintained, and every sharp
edge in dual-WAN failover — probe hysteresis, multi-target tracking, conntrack
flushing on switchover, hotplug integration — is something it has already
iterated on for a decade. That is not the problem.

The problem is that mwan3 is a *general* policy-routing tool, and its LuCI app
exposes that generality: six configuration tabs and four status tabs, built
around Interfaces, Members, Policies and Rules. A pure failover setup needs six
sections across five of those screens, and none of the concepts it makes you
learn are ones you asked about. The recurring forum complaint is not that mwan3
does not work; it is that the documentation is "huge and complex" for what
people consider a basic two-uplink job.

Roughly half a dozen projects have responded to that by reimplementing failover
from scratch, starting around 2010. None of them displaced mwan3 and most are
dead. The one adjacent tool with real traction does detection only and
deliberately refuses to own the failover logic. The revealed preference is
clear: people want a better *configuration UX* around mwan3, not another
daemon. wansentry is that, and nothing more.

## How it compares

| | `luci-app-mwan3` | `luci-app-wansentry` |
|---|---|---|
| Scope | Every mwan3 feature: load balancing, weights, arbitrary policies and rules | Failover only: one primary, one backup |
| Screens for a working setup | 5 configuration tabs (+2 more you can ignore, +4 status) | 1 |
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
complete minimal mwan3 failover configuration and not one section more. The
screen renders the exact text before you apply it. Regeneration is idempotent:
applying an unchanged configuration produces zero uci operations.

## Opinions it holds

- **Any one health-check host answering keeps an uplink up.** ICMP-hostile
  upstreams are common; demanding that every target respond turns one of them
  into a phantom outage.
- **Recovery is slower than failure.** The recovery threshold defaults higher
  than the failure threshold, because flapping back onto a shaky primary is
  worse than staying on a working backup a little longer.
- **Conntrack is flushed on every transition by default**, because TCP treats
  the ICMP unreachables from a dead gateway as a soft error and clients will
  retransmit into it for minutes otherwise.
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

    apk update
    apk install luci-app-wansentry     # pulls in mwan3

Then **Network → WAN Failover**.

## License

Apache-2.0 — see [LICENSE](LICENSE).
