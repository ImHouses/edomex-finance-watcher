/**
 * Minimal Telegram sendMessage wrapper. Plain text only — no parse_mode, no
 * inline keyboards. Throws on non-2xx so callers can route to the failure path.
 *
 * If TELEGRAM_DRY_RUN=1 is set, no HTTP request is made; the message is logged
 * to stdout with a `[DRY RUN]` prefix instead. Used by the validation suite to
 * avoid spamming the user during repeated test runs.
 */
export async function sendTelegram(
  token: string,
  chatId: string,
  text: string,
): Promise<void> {
  if (process.env.TELEGRAM_DRY_RUN === "1") {
    console.log(`[DRY RUN] telegram → chat_id=${chatId}\n${text}`);
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram sendMessage failed: ${res.status} ${res.statusText} — ${body.slice(0, 300)}`);
  }
}
