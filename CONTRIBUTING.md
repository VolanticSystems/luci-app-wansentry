# Contributing to luci-app-wansentry

Contributions are welcome, including bug reports, and especially the live
failover test described under *Where help is most useful* below.

## Scope, before you start

wansentry is deliberately narrow: **IPv4 failover between exactly two
uplinks, on one screen, with nine fields.** Load balancing, more than two
uplinks, per-destination policy routing and a second mwan3 options editor are
explicit non-goals, argued in [docs/DESIGN.md](docs/DESIGN.md) 1 and 2.

That is not gatekeeping for its own sake. The whole premise is that
`luci-app-mwan3` already exposes every mwan3 feature, and the gap in the
ecosystem is a *simple* front end rather than another complete one. A patch
that adds a tab tends to be a patch that removes the reason this package
exists. If you need the full model, `luci-app-mwan3` is the right tool and
wansentry will step aside for it automatically.

Fixes, correctness improvements, better diagnostics and clearer wording are
all welcome without reservation.

## Reporting a problem

Useful reports include:

- Device, OpenWrt release, and mwan3 version (`apk info mwan3`).
- The generated configuration: `uci show mwan3`.
- wansentry's own settings: `uci show wansentry`.
- `logread -e mwan3` around the event.
- Whether mwan3 was configured by hand before wansentry was installed, since
  wansentry deliberately refuses to manage a configuration it did not create.

## Building

This repository is a LuCI-style feed: the root `Makefile` includes
`$(TOPDIR)/feeds/luci/luci.mk`, so it drops into an OpenWrt SDK tree.

    ./scripts/feeds update -a
    ./scripts/feeds install -a
    git clone https://github.com/VolanticSystems/luci-app-wansentry.git \
        package/luci-app-wansentry
    make package/luci-app-wansentry/compile V=s

CI builds against the OpenWrt SDK on every push and pull request.

## Testing a change on a device

The views are plain JS, so no rebuild is needed to iterate:

    # after replacing a view under /www/luci-static/resources/view/wansentry/
    rm -f /tmp/luci-indexcache.*
    /etc/init.d/rpcd restart && /etc/init.d/uhttpd restart

Two behaviours are easy to break and worth re-checking after any change to
the generator or the apply path:

- **Ownership.** wansentry must never modify or delete an mwan3 section it
  did not create. Both `generator.js` (`isOwned`) and
  `/etc/init.d/wansentry` enforce this, and they must agree.
- **All-or-nothing save.** Validation runs *before* anything is staged, so a
  rejected form leaves no partial change to ride out on a later apply from
  another page. This has been broken twice by well-meaning refactors.

Please confirm changes on real hardware. Rollback behaviour in particular
cannot be reasoned about from the source alone: on a LAN-safe apply this LuCI
build auto-confirms as soon as the device is reachable, so a rollback test
has to *provoke* unreachability rather than assume that doing nothing
produces it.

## Code style

Match the surrounding code:

- `generator.js` is deliberately DOM-free. It is the part worth reasoning
  about in isolation, and it should stay testable as a pure function from
  settings to desired mwan3 sections. Keep DOM work in `overview.js`.
- No bundler, no framework, no charting library. LuCI's own `form`, `ui`,
  `rpc`, `poll` and `dom` modules only.
- Nothing in this package runs a shell, with one deliberate exception
  (`logread` for the event list, which has no ubus equivalent). Please keep it
  that way.
- SPDX headers on new files, Apache-2.0.

## Commits

Prefix the subject with the package name, lowercase after the colon:

    luci-app-wansentry: widen the probe-host column on narrow screens

If you would like the change to be portable upstream to `openwrt/luci` later,
add a `Signed-off-by:` line with your real name, which is what upstream's DCO
requires.

## Where help is most useful

**A live failover under load.** Everything else about this package has been
verified on hardware: config generation, idempotent rewrite, the ownership
refusal, rollback, and service reconciliation. The one thing that has not been
tested is the event the package exists to handle, because the development
bench had only one real uplink. If you run wansentry with two genuinely live
uplinks and pull the primary while traffic is flowing, a report of what
happened is the single most valuable contribution available right now,
patch or no patch.

Worth including: whether the switchover happened, roughly how long it took,
whether existing connections recovered or hung, and whether conntrack
flushing behaved as expected.
