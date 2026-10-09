// ครอบ handler: สร้าง context + แปลง error เป็นข้อความภาษาไทยที่ปลอดภัย
import { getContext } from "./context.mjs";
import { sendError } from "./http.mjs";

export function route(fn) {
  return async function handler(req, res) {
    try {
      const ctx = await getContext();
      await fn(req, res, ctx);
    } catch (err) {
      sendError(res, err);
    }
  };
}
