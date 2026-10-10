# SPDX-License-Identifier: Apache-2.0
#
# Copyright 2026 VolanticSystems

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-wansentry
PKG_VERSION:=1.2.1
PKG_RELEASE:=1
PKG_LICENSE:=Apache-2.0
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=Bob <git16@bob7.com>

LUCI_TITLE:=Single-screen WAN and VPN failover (mwan3 configuration generator)
LUCI_DESCRIPTION:=One opinionated LuCI screen that turns "primary WAN, backup WAN, \
	these health-check hosts" into a complete, minimal, correct mwan3 configuration, \
	and optionally fails over between VPN tunnels with a killswitch for traffic that \
	pbr sends into them. Email on every down/up transition and a daily report of every \
	path. Failover only: no load balancing, no policy zoo, no six tabs. wansentry owns \
	the sections it generates and refuses to touch mwan3 configuration it did not create.
LUCI_DEPENDS:=+mwan3 +luci-base +conntrack +msmtp
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
