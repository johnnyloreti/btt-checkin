// purchases.js — the tab itself (§15.3): the no-card flag now, purchase
// recording and the staff views in steps 4 and 5.

/** True when the payer's last close-out found no usable card (tab_flags). */
export async function hasNoCardFlag(env, contactId) {
  const row = await env.DB.prepare('SELECT no_card_since FROM tab_flags WHERE payer_contact_id = ?').bind(contactId).first();
  return Boolean(row);
}

export async function clearNoCardFlag(env, contactId) {
  const r = await env.DB.prepare('DELETE FROM tab_flags WHERE payer_contact_id = ?').bind(contactId).run();
  return { ok: true, cleared: Number(r?.meta?.changes ?? 0) > 0 };
}
