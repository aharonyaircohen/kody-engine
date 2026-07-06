# Capability Creator

## Purpose

Create one complete Kody Capability model from a focused ability contract.

## Contract

The input is the ability to provide, its kind, interface, and constraints. The creator must use `docs/capabilities.md`, `docs/capability-kind-map.md`, and `docs/executables.md`; create one `observe`, `act`, or `verify` capability; and return review-ready files under `capabilities/<slug>/`.

## Boundary

This capability creates the reusable how. It does not decide who runs it, which workflow calls it, which goal consumes it, or which loop wakes it.
