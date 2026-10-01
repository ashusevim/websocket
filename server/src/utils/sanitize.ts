/**
 * Message text is stored and sent as plain text, never as HTML.
 *
 * The client renders every message with `textContent` /
 * `document.createTextNode` (client/index.html), so HTML metacharacters are
 * already inert at the point of display. HTML-encoding here would therefore
 * be encoded a second time on the client and the user would literally see
 * `&lt;b&gt;bold&lt;/b&gt;` instead of `<b>bold</b>`.
 *
 * So the server's job is NOT to escape HTML. It is to strip the control
 * characters that break rendering and log lines, and to bound the length.
 * XSS defence belongs at the sink (textContent), which is where it already is.
 */
export function sanitize(str: string): string {
    return str
        // C0 controls except tab (\t) and newline (\n); also DEL.
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
        // Normalise CRLF/CR so every client sees the same line breaks.
        .replace(/\r\n?/g, "\n")
        .trim();
}
