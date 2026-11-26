import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getSql, prepareDatabase } from './_db.js';

const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
const validTime = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
const clean = (value, max = 100) => String(value || '').trim().slice(0, max);
const normalizeTelegram = (value) => clean(value, 33).replace(/^@/, '').toLowerCase();
const validTelegram = (value) => /^(?:\d{4,20}|[a-z][a-z0-9_]{4,31})$/.test(value);

function sessionValue() {
  const body = Buffer.from(JSON.stringify({ role: 'admin', exp: Date.now() + 1000 * 60 * 60 * 24 * 14 })).toString('base64url');
  const signature = createHmac('sha256', process.env.SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}
function isAdmin(req) {
  const raw = req.headers.cookie || '';
  const cookie = raw.split(';').map((x) => x.trim()).find((x) => x.startsWith('kt_admin='))?.slice(9);
  if (!cookie || !process.env.SESSION_SECRET) return false;
  const [body, signature] = cookie.split('.');
  if (!body || !signature) return false;
  const expected = createHmac('sha256', process.env.SESSION_SECRET).update(body).digest();
  let actual;
  try { actual = Buffer.from(signature, 'base64url'); } catch { return false; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  try { const payload = JSON.parse(Buffer.from(body, 'base64url').toString()); return payload.role === 'admin' && payload.exp > Date.now(); } catch { return false; }
}
function send(res, status, data, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(JSON.stringify(data));
}
function body(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; if (text.length > 30000) reject(new Error('Request too large')); });
    req.on('end', () => { try { resolve(JSON.parse(text || '{}')); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function setCookie(res, value) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `kt_admin=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600${secure}`);
}
function unsetCookie(res) { res.setHeader('Set-Cookie', 'kt_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'); }
function forbidden(res) { return send(res, 401, { error: 'Нужен вход администратора' }); }
function range(req, values = req.query || {}) {
  const from = String(values.from || '');
  const to = String(values.to || '');
  if (!validDate(from) || !validDate(to) || from > to) return null;
  return { from, to };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const action = clean(req.query?.action || req.body?.action, 50);
  try {
    if (action === 'login') {
      const input = await body(req);
      const supplied = Buffer.from(hash(input.password || ''), 'hex');
      const configured = Buffer.from(hash(process.env.ADMIN_PASSWORD || 'missing-admin-password'), 'hex');
      if (!process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET || !timingSafeEqual(supplied, configured)) return send(res, 401, { error: 'Неверный пароль или не настроены секреты приложения' });
      setCookie(res, sessionValue());
      return send(res, 200, { ok: true });
    }
    if (action === 'logout') { unsetCookie(res); return send(res, 200, { ok: true }); }
    const publicAction = action === 'register' || action === 'worker_load' || action === 'worker_save';
    if (!publicAction && !isAdmin(req)) return forbidden(res);
    const sql = getSql();
    await prepareDatabase(sql);
    if (action === 'register') {
      const input = await body(req);
      const first = clean(input.firstName, 80), last = clean(input.lastName, 80), telegram = normalizeTelegram(input.telegramId);
      const invite = clean(input.invite, 120);
      if (!first || !last || !validTelegram(telegram) || !invite) return send(res, 400, { error: 'Заполните имя, фамилию и Telegram username (например, @fqzik) или ID из цифр' });
      const invites = await sql`SELECT id FROM registration_invites WHERE token_hash = ${hash(invite)} AND active = true LIMIT 1`;
      if (!invites.length) return send(res, 403, { error: 'Ссылка регистрации недействительна или отключена' });
      const personal = token();
      const id = randomUUID();
      try {
        await sql`INSERT INTO employees (id, first_name, last_name, telegram_id, access_hash) VALUES (${id}, ${first}, ${last}, ${telegram}, ${hash(personal)})`;
      } catch (error) {
        if (error.code === '23505') return send(res, 409, { error: 'Этот Telegram username или ID уже зарегистрирован. Попросите администратора помочь со входом.' });
        throw error;
      }
      return send(res, 201, { ok: true, token: personal, employee: { firstName: first, lastName: last } });
    }
    if (action === 'worker_load' || action === 'worker_save') {
      const input = req.method === 'GET' ? req.query : await body(req);
      const key = clean(input.token, 150);
      if (!key) return send(res, 401, { error: 'В ссылке нет ключа сотрудника' });
      const workers = await sql`SELECT id, first_name, last_name FROM employees WHERE access_hash = ${hash(key)} AND active = true LIMIT 1`;
      if (!workers.length) return send(res, 401, { error: 'Ссылка сотрудника не найдена или отключена' });
      const worker = workers[0];
      if (action === 'worker_load') {
        const dates = range(req, input);
        if (!dates) return send(res, 400, { error: 'Не задан период' });
        const values = await sql`SELECT work_date::text AS date, to_char(available_from, 'HH24:MI') AS start, to_char(available_to, 'HH24:MI') AS end FROM availability WHERE employee_id = ${worker.id} AND work_date BETWEEN ${dates.from} AND ${dates.to} ORDER BY work_date`;
        return send(res, 200, { employee: { firstName: worker.first_name, lastName: worker.last_name }, availability: values });
      }
      const entries = Array.isArray(input.days) ? input.days.slice(0, 7) : [];
      if (!validDate(input.from) || !validDate(input.to) || input.from > input.to) return send(res, 400, { error: 'Не задан период доступности' });
      for (const entry of entries) if (!validDate(entry.date) || entry.date < input.from || entry.date > input.to || !validTime(entry.start) || !validTime(entry.end) || entry.start >= entry.end) return send(res, 400, { error: 'Проверьте даты и время доступности' });
      await sql.transaction([
        sql`DELETE FROM availability WHERE employee_id = ${worker.id} AND work_date BETWEEN ${input.from} AND ${input.to}`,
        ...entries.map((entry) => sql`INSERT INTO availability (employee_id, work_date, available_from, available_to) VALUES (${worker.id}, ${entry.date}, ${entry.start}, ${entry.end}) ON CONFLICT (employee_id, work_date) DO UPDATE SET available_from = EXCLUDED.available_from, available_to = EXCLUDED.available_to, updated_at = now()`),
      ]);
      return send(res, 200, { ok: true });
    }
    if (action === 'admin_data') {
      const dates = range(req);
      if (!dates) return send(res, 400, { error: 'Не задан период' });
      const [employees, points, pointDays, shifts, availability, invites] = await Promise.all([
        sql`SELECT id, first_name AS "firstName", last_name AS "lastName", telegram_id AS "telegramId" FROM employees WHERE active = true ORDER BY last_name, first_name`,
        sql`SELECT id, name, address FROM points WHERE active = true ORDER BY name`,
        sql`SELECT point_id AS "pointId", work_date::text AS date, is_open AS open, to_char(opens_at, 'HH24:MI') AS "opensAt", to_char(closes_at, 'HH24:MI') AS "closesAt", required_count AS "requiredCount" FROM point_days WHERE work_date BETWEEN ${dates.from} AND ${dates.to}`,
        sql`SELECT id, work_date::text AS date, point_id AS "pointId", employee_id AS "employeeId", to_char(starts_at, 'HH24:MI') AS start, to_char(ends_at, 'HH24:MI') AS end FROM shifts WHERE work_date BETWEEN ${dates.from} AND ${dates.to} ORDER BY work_date, starts_at`,
        sql`SELECT employee_id AS "employeeId", work_date::text AS date, to_char(available_from, 'HH24:MI') AS start, to_char(available_to, 'HH24:MI') AS end FROM availability WHERE work_date BETWEEN ${dates.from} AND ${dates.to}`,
        sql`SELECT count(*)::int AS count FROM registration_invites WHERE active = true`
      ]);
      return send(res, 200, { employees, points, pointDays, shifts, availability, activeInvites: invites[0]?.count || 0 });
    }
    if (action === 'invite_create') {
      const code = token();
      await sql`INSERT INTO registration_invites (id, token_hash) VALUES (${randomUUID()}, ${hash(code)})`;
      const origin = req.headers.origin || `https://${req.headers.host}`;
      return send(res, 201, { url: `${origin}/employee.html#invite=${encodeURIComponent(code)}` });
    }
    if (action === 'invite_disable') {
      await sql`UPDATE registration_invites SET active = false WHERE active = true`;
      return send(res, 200, { ok: true });
    }
    if (action === 'employee_add') {
      const input = await body(req); const first = clean(input.firstName, 80), last = clean(input.lastName, 80), telegram = normalizeTelegram(input.telegramId);
      if (!first || !last || !validTelegram(telegram)) return send(res, 400, { error: 'Укажите имя, фамилию и Telegram username (например, @fqzik) или ID из цифр' });
      const personal = token();
      try { await sql`INSERT INTO employees (id, first_name, last_name, telegram_id, access_hash) VALUES (${randomUUID()}, ${first}, ${last}, ${telegram}, ${hash(personal)})`; }
      catch (error) { if (error.code === '23505') return send(res, 409, { error: 'Такой Telegram username или ID уже есть в списке' }); throw error; }
      return send(res, 201, { ok: true, url: `${req.headers.origin || `https://${req.headers.host}`}/employee.html#token=${encodeURIComponent(personal)}` });
    }
    if (action === 'employee_add_link') {
      const input = await body(req);
      if (!input.id) return send(res, 400, { error: 'Не выбран сотрудник' });
      const personal = token();
      const updated = await sql`UPDATE employees SET access_hash=${hash(personal)} WHERE id=${input.id} AND active=true RETURNING id`;
      if (!updated.length) return send(res, 404, { error: 'Сотрудник не найден' });
      return send(res, 200, { url: `${req.headers.origin || `https://${req.headers.host}`}/employee.html#token=${encodeURIComponent(personal)}` });
    }
    if (action === 'employee_update') {
      const input = await body(req); const first = clean(input.firstName, 80), last = clean(input.lastName, 80), telegram = normalizeTelegram(input.telegramId);
      if (!input.id || !first || !last || !validTelegram(telegram)) return send(res, 400, { error: 'Проверьте имя, фамилию и Telegram username или ID' });
      await sql`UPDATE employees SET first_name=${first}, last_name=${last}, telegram_id=${telegram} WHERE id=${input.id} AND active=true`;
      return send(res, 200, { ok: true });
    }
    if (action === 'point_add') {
      const input = await body(req); const name = clean(input.name, 100);
      if (!name) return send(res, 400, { error: 'Введите название точки' });
      const id = randomUUID(); await sql`INSERT INTO points (id, name, address) VALUES (${id}, ${name}, ${clean(input.address, 200)})`;
      return send(res, 201, { id });
    }
    if (action === 'point_update') {
      const input = await body(req); const name = clean(input.name, 100);
      if (!input.id || !name) return send(res, 400, { error: 'Введите название точки' });
      await sql`UPDATE points SET name=${name}, address=${clean(input.address, 200)} WHERE id=${input.id} AND active=true`;
      return send(res, 200, { ok: true });
    }
    if (action === 'day_update') {
      const input = await body(req);
      if (!input.pointId || !validDate(input.date) || !validTime(input.opensAt) || !validTime(input.closesAt) || input.opensAt >= input.closesAt) return send(res, 400, { error: 'Проверьте часы работы' });
      await sql`INSERT INTO point_days (point_id, work_date, is_open, opens_at, closes_at, required_count) VALUES (${input.pointId}, ${input.date}, ${Boolean(input.open)}, ${input.opensAt}, ${input.closesAt}, ${Math.max(0, Math.min(50, Number(input.requiredCount)||0))}) ON CONFLICT (point_id, work_date) DO UPDATE SET is_open=EXCLUDED.is_open, opens_at=EXCLUDED.opens_at, closes_at=EXCLUDED.closes_at, required_count=EXCLUDED.required_count`;
      return send(res, 200, { ok: true });
    }
    if (action === 'shift_save') {
      const input = await body(req);
      if (!validDate(input.date) || !validTime(input.start) || !validTime(input.end) || input.start >= input.end || !input.pointId) return send(res, 400, { error: 'Проверьте дату, точку и время смены' });
      const configs = await sql`SELECT is_open, to_char(opens_at,'HH24:MI') AS start, to_char(closes_at,'HH24:MI') AS end FROM point_days WHERE point_id=${input.pointId} AND work_date=${input.date} LIMIT 1`;
      if (configs.length && (!configs[0].is_open || input.start < configs[0].start || input.end > configs[0].end)) return send(res, 409, { error: 'Смена выходит за часы работы точки или точка закрыта' });
      if (input.employeeId) {
        const conflict = await sql`SELECT id FROM shifts WHERE employee_id=${input.employeeId} AND work_date=${input.date} AND starts_at < ${input.end} AND ends_at > ${input.start} AND id <> ${input.id || ''} LIMIT 1`;
        if (conflict.length) return send(res, 409, { error: 'У сотрудника уже есть пересекающаяся смена' });
      }
      const id = input.id || randomUUID();
      await sql`INSERT INTO shifts (id, work_date, point_id, employee_id, starts_at, ends_at) VALUES (${id}, ${input.date}, ${input.pointId}, ${input.employeeId || null}, ${input.start}, ${input.end}) ON CONFLICT (id) DO UPDATE SET work_date=EXCLUDED.work_date, point_id=EXCLUDED.point_id, employee_id=EXCLUDED.employee_id, starts_at=EXCLUDED.starts_at, ends_at=EXCLUDED.ends_at`;
      return send(res, 200, { ok: true });
    }
    if (action === 'draft_save') {
      const input = await body(req);
      const shifts = Array.isArray(input.shifts) ? input.shifts.slice(0, 250) : [];
      if (!shifts.length) return send(res, 200, { ok: true, count: 0 });
      for (const s of shifts) if (!validDate(s.date) || !validTime(s.start) || !validTime(s.end) || s.start >= s.end || !s.pointId || !s.employeeId) return send(res, 400, { error: 'В черновике есть некорректная смена' });
      const dates = shifts.map((s) => s.date).sort();
      const from = dates[0], to = dates[dates.length - 1];
      const [current, availabilityRows, configs] = await Promise.all([
        sql`SELECT id, work_date::text AS date, employee_id AS "employeeId", to_char(starts_at,'HH24:MI') AS start, to_char(ends_at,'HH24:MI') AS end FROM shifts WHERE work_date BETWEEN ${from} AND ${to}`,
        sql`SELECT employee_id AS "employeeId", work_date::text AS date, to_char(available_from,'HH24:MI') AS start, to_char(available_to,'HH24:MI') AS end FROM availability WHERE work_date BETWEEN ${from} AND ${to}`,
        sql`SELECT point_id AS "pointId", work_date::text AS date, is_open AS open, to_char(opens_at,'HH24:MI') AS start, to_char(closes_at,'HH24:MI') AS end FROM point_days WHERE work_date BETWEEN ${from} AND ${to}`
      ]);
      const availabilityMap = new Map(availabilityRows.map((a) => [`${a.employeeId}|${a.date}`, a]));
      const configMap = new Map(configs.map((c) => [`${c.pointId}|${c.date}`, c]));
      const accepted = [];
      for (const s of shifts) {
        const a = availabilityMap.get(`${s.employeeId}|${s.date}`);
        if (!a || s.start < a.start || s.end > a.end) return send(res, 409, { error: 'Черновик назначает сотруднику время вне его доступности. Обновите страницу и попробуйте снова.' });
        const c = configMap.get(`${s.pointId}|${s.date}`) || { open: true, start: '10:00', end: '22:00' };
        if (!c.open || s.start < c.start || s.end > c.end) return send(res, 409, { error: 'В черновике есть смена вне часов работы точки.' });
        const conflict = [...current, ...accepted].some((x) => x.employeeId === s.employeeId && x.date === s.date && x.start < s.end && x.end > s.start);
        if (conflict) return send(res, 409, { error: 'В черновике есть пересекающиеся смены одного сотрудника.' });
        accepted.push(s);
      }
      await sql.transaction(accepted.map((s) => sql`INSERT INTO shifts (id, work_date, point_id, employee_id, starts_at, ends_at) VALUES (${randomUUID()}, ${s.date}, ${s.pointId}, ${s.employeeId}, ${s.start}, ${s.end})`));
      return send(res, 200, { ok: true, count: accepted.length });
    }
    if (action === 'shift_delete') {
      const input = await body(req); await sql`DELETE FROM shifts WHERE id=${input.id}`; return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'Неизвестное действие API' });
  } catch (error) {
    console.error('KutiKatai API error:', error);
    return send(res, 500, { error: 'Не удалось выполнить операцию. Проверьте настройки базы данных.' });
  }
}

