/**
 * The preview pane's address bar, as a decision about what a typed address means.
 *
 * The bar used to be read-only, and the reason was good: a preview's URL is derived from the
 * build and the frame's own path, so a typed value had nowhere to go. But a preview that
 * cannot be pointed anywhere is a preview of exactly one thing, and the thing a user actually
 * wants to look at is the server *they* started \u2014 on their port, at their path. So the bar
 * takes input now, and this module is the only place that decides what the input means.
 *
 * Four answers, and each one is a sentence rather than a guess:
 *
 * - **`localhost:1234`** (or `http://localhost:1234/a/b`) \u2192 open the guest's loopback on that
 *   port, at that path. This is the case the feature exists for: `bun run dev -- -p 1234` in
 *   the guest terminal plus this address is the whole configuration.
 * - **a bare path** (`/about`, `app/editor`) \u2192 stay on the origin the pane is already on, and
 *   go to that path. That is what a browser does, and it is what makes the bar useful for
 *   walking an SPA without clicking.
 * - **a refusal** for anything else, with the sentence that says why. A refused address must
 *   never be a blank frame: the pane keeps showing what it was showing and prints the reason
 *   beside the bar.
 *
 * Two rules are deliberately strict:
 *
 * - **The host is the guest's loopback or nothing.** The preview reaches the guest through
 *   `kernel.fetch()`, whose only reachable host is the guest's own `localhost`. Accepting
 *   `example.com` would produce a socket error dressed up as a preview failure, which teaches
 *   the user that the product is broken. `127.0.0.1` and `[::1]` are accepted because they name
 *   the same loopback, and a developer types them.
 * - **The scheme is `http`.** A guest dev server is plain HTTP; `https://localhost:1234` is a
 *   TLS handshake against a server that will never complete one, so it is refused in words.
 */

import { normalisePath } from "@/ui/preview-browser";

/** What a typed address means. */
export type AddressTarget =
  /** A path on the origin the pane is already showing. */
  | { kind: "path"; path: string }
  /** A guest server: a port on the guest's loopback, and a path inside it. */
  | { kind: "guest"; port: number; path: string }
  /** Nothing the preview can open, with the sentence to show instead. */
  | { kind: "refused"; message: string };

/** The host spellings that mean "the guest's own loopback". */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export interface ParseAddressOptions {
  /** The port the preview is configured for; used in messages, never as a silent default. */
  currentPort?: number;
}

/** A refusal, in the pane's own words. */
function refused(message: string): AddressTarget {
  return { kind: "refused", message };
}

/** The `host:port` at the start of `text`, split without a URL parser (which needs a scheme). */
function splitHostPort(text: string): { host: string; port: string | null; rest: string } | null {
  // The authority ends at the first `/`, `?` or `#`.
  const end = text.search(/[/?#]/);
  const authority = end === -1 ? text : text.slice(0, end);
  const rest = end === -1 ? "" : text.slice(end);
  if (authority.length === 0) return null;

  // A bracketed IPv6 literal (`[::1]:1234`) is one host with colons inside it.
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close === -1) return null;
    const host = authority.slice(0, close + 1);
    const after = authority.slice(close + 1);
    if (after.length === 0) return { host, port: null, rest };
    if (!after.startsWith(":")) return null;
    return { host, port: after.slice(1), rest };
  }

  const colon = authority.indexOf(":");
  if (colon === -1) return { host: authority, port: null, rest };
  return { host: authority.slice(0, colon), port: authority.slice(colon + 1), rest };
}

/** True for `example.com`, `sub.example.co.uk`, but not for `docs/index.html` or `app`. */
function looksLikeDottedHost(authority: string): boolean {
  return /^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(authority);
}

/** A port, or null when the text is not one. Digits only, same rule as the Settings field. */
function parsePortText(text: string): number | null {
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65_535 ? port : null;
}

/** The path (with its query and fragment) from a URL-shaped string, normalised. */
function pathOf(url: URL): string {
  const path = normalisePath(url.pathname);
  return `${path === "/" ? "/" : path}${url.search}${url.hash}`;
}

/**
 * Understand what the user typed.
 *
 * `currentPort` is only ever used to write a helpful example (`localhost:5173`), never as a
 * default: `localhost` with no port is refused rather than silently pointed at the configured
 * port, because a browser would have meant port 80 and guessing is how a preview ends up
 * showing a 404 nobody asked for.
 */
export function parsePreviewAddress(input: string, options: ParseAddressOptions = {}): AddressTarget {
  const text = input.trim();
  const example = `localhost:${String(options.currentPort ?? 5173)}`;

  if (text.length === 0) {
    return refused(`Type an address first \u2014 ${example}, or a path such as /about.`);
  }

  // A scheme is unambiguous, so it is handled by the URL parser and then checked.
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(text);
  if (scheme !== null) {
    const name = (scheme[1] ?? "").toLowerCase();
    if (name !== "http") {
      return refused(
        name === "https"
          ? `The guest's server speaks plain HTTP, so ${text} cannot be opened. Try http://${example}/ instead.`
          : `The preview opens HTTP addresses, not ${name}:. Try http://${example}/.`,
      );
    }
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return refused(`${text} is not a URL the preview can read. Try ${example}.`);
    }
    return targetForHost(url.hostname, url.port, pathOf(url), example, text);
  }

  // Protocol-relative (`//example.com/x`) is another origin wearing a path's clothes.
  if (text.startsWith("//")) {
    return refused(`${text} points at another host. The preview can only open the guest's own loopback \u2014 try ${example}.`);
  }

  // A bare path stays where it is. Checked before the host rules, because `/a/b` has no host.
  if (text.startsWith("/")) return { kind: "path", path: normalisePath(text) };

  const split = splitHostPort(text);
  if (split !== null) {
    const host = split.host.toLowerCase();
    // `host:port` is never a path: the colon is a port separator, and treating `example.com:1234`
    // as the path `/example.com:1234` would quietly open a page nobody asked for.
    if (split.port !== null) {
      return targetForHost(split.host, split.port, split.rest, example, text);
    }
    if (LOOPBACK_HOSTS.has(host)) {
      return refused(
        `Add the port your server listens on, for example ${example}. A bare ${split.host} would mean port 80, which no guest server listens on.`,
      );
    }
    if (looksLikeDottedHost(split.host)) {
      return refused(
        `${text} is another host. The preview can only open the guest's own loopback \u2014 type ${example}.`,
      );
    }
  }

  // Everything else is a path on the origin on screen: `about`, `app/editor`, `docs/index.html`.
  return { kind: "path", path: normalisePath(text) };
}

/** One host/port pair as an answer: the guest, or the sentence that says why not. */
function targetForHost(
  hostname: string,
  port: string,
  path: string,
  example: string,
  typed: string,
): AddressTarget {
  const host = hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    return refused(
      `${typed} is another host. The preview can only open the guest's own loopback \u2014 type ${example}.`,
    );
  }
  if (port.length === 0) {
    return refused(`Add the port your server listens on, for example ${example}.`);
  }
  const portNumber = parsePortText(port);
  if (portNumber === null) {
    return refused(`"${port}" is not a port. Use a number between 1 and 65535.`);
  }
  return { kind: "guest", port: portNumber, path: normalisePath(path) };
}

/**
 * The address a guest server is shown at, as the bar prints it.
 *
 * `localhost:1234/` and `localhost:1234/app` \u2014 no `http://`, because every browser hides it and
 * the point of the bar is to read like one. The pane's own URL space (`/__preview__/<id>/`) is
 * an implementation detail the user never typed and should not have to parse.
 */
export function guestAddressFor(port: number, path: string): string {
  const normalised = normalisePath(path);
  return `localhost:${String(port)}${normalised === "/" ? "/" : normalised}`;
}
