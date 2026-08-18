// Writes an entry to activity_log. Categories: account | settings | call | donation | admin | system
import { nowIso } from "./util.js";

export async function logActivity(db, { actorUser = null, actorLabel = null, category, actionText, targetLabel = null }) {
  const label = actorLabel || (actorUser ? (actorUser.name || actorUser.mobile) : "সিস্টেম");
  await db
    .prepare(
      "INSERT INTO activity_log (actor_user_id, actor_label, category, action_text, target_label, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(actorUser ? actorUser.id : null, label, category, actionText, targetLabel, nowIso())
    .run();
}
