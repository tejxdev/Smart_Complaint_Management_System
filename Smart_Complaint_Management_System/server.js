require("dotenv").config();

const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mysql = require("mysql2/promise");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET === "replace_this_with_a_long_random_secret") {
  console.warn("WARNING: Set a private JWT_SECRET in your .env file before using this outside local practice.");
}

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "complaint_management",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

async function ensureUserStatusColumn() {
  const [columns] = await pool.execute(
    `SELECT COUNT(*) AS columnCount
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'users'
       AND COLUMN_NAME = 'is_active'`
  );
  if (Number(columns[0].columnCount) === 0) {
    await pool.query("ALTER TABLE users ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1");
    console.log("Added users.is_active for account management.");
  }
}

async function ensureAdminAuditTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NOT NULL,
      admin_email VARCHAR(150) NOT NULL,
      action VARCHAR(80) NOT NULL,
      entity_type VARCHAR(40) NOT NULL,
      entity_id BIGINT NOT NULL,
      details JSON NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_admin_audit_created_at (created_at),
      INDEX idx_admin_audit_admin_id (admin_id),
      INDEX idx_admin_audit_entity (entity_type, entity_id)
    )
  `);
}

async function recordAdminAudit(connection, req, { action, entityType, entityId, details }) {
  await connection.execute(
    `INSERT INTO admin_audit_logs
       (admin_id, admin_email, action, entity_type, entity_id, details)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      req.user.id,
      req.user.email,
      action,
      entityType,
      entityId,
      JSON.stringify(details)
    ]
  );
}

function createToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    JWT_SECRET || "local-development-only-secret",
    { expiresIn: "2h" }
  );
}

async function authRequired(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ message: "Please provide a Bearer token in the Authorization header." });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET || "local-development-only-secret");
  } catch {
    return res.status(401).json({ message: "Invalid or expired token. Please log in again." });
  }
  try {
    const [rows] = await pool.execute(
      "SELECT id, email, role, is_active FROM users WHERE id = ?",
      [req.user.id]
    );
    if (!rows.length || !rows[0].is_active) {
      return res.status(401).json({ message: "This account is deactivated or no longer available." });
    }
    req.user = { ...req.user, email: rows[0].email, role: rows[0].role };
    next();
  } catch (err) {
    next(err);
  }
}

function adminRequired(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ message: "Admin access required." });
  }
  next();
}

function validEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

app.get("/", (_req, res) => {
  res.json({
    name: "Smart Complaint Management System API",
    status: "running",
    features: [
      "User registration and login",
      "Submit complaints",
      "View and update own complaints",
      "Admin complaint status updates",
      "Search and filter complaints"
    ],
    tip: "Read README.md for setup and API instructions."
  });
});

app.get("/api", (_req, res) => {
  res.json({
    name: "Smart Complaint Management System API",
    status: "running",
    endpoints: {
      health: "/api/health",
      register: "POST /api/auth/register",
      login: "POST /api/auth/login",
      complaints: "/api/complaints",
      adminComplaints: "/api/admin/complaints",
      adminUsers: "/api/admin/users"
    }
  });
});

app.get("/api/", (_req, res) => {
  res.redirect(308, "/api");
});

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch (err) {
    res.status(503).json({ status: "error", database: "not connected", detail: err.code || "DB_ERROR" });
  }
});

// Feature 1: User registration. Public registration always creates a normal user.
app.post("/api/auth/register", async (req, res, next) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || typeof name !== "string" || name.trim().length < 2) {
      return res.status(400).json({ message: "Name must contain at least 2 characters." });
    }
    if (!validEmail(email)) {
      return res.status(400).json({ message: "Please enter a valid email address." });
    }
    if (typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters long." });
    }

    const [existing] = await pool.execute("SELECT id FROM users WHERE email = ?", [email.toLowerCase().trim()]);
    if (existing.length) return res.status(409).json({ message: "An account with this email already exists." });

    const passwordHash = await bcrypt.hash(password, 10);
    const [result] = await pool.execute(
      "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'user')",
      [name.trim(), email.toLowerCase().trim(), passwordHash]
    );
    res.status(201).json({ message: "Registration successful. Please log in.", userId: result.insertId });
  } catch (err) {
    next(err);
  }
});

// Feature 2: User/admin login.
app.post("/api/auth/login", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!validEmail(email) || typeof password !== "string" || !password) {
      return res.status(400).json({ message: "Email and password are required." });
    }
    const [rows] = await pool.execute(
      "SELECT id, name, email, password_hash, role, is_active FROM users WHERE email = ?",
      [email.toLowerCase().trim()]
    );
    if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) {
      return res.status(401).json({ message: "Invalid email or password." });
    }
    const user = rows[0];
    if (!user.is_active) {
      return res.status(403).json({ message: "This account has been deactivated. Contact an administrator." });
    }
    res.json({
      message: "Login successful.",
      token: createToken(user),
      user: { id: user.id, name: user.name, email: user.email, role: user.role }
    });
  } catch (err) {
    next(err);
  }
});

// Feature 3: Submit a complaint.
app.post("/api/complaints", authRequired, async (req, res, next) => {
  try {
    const { title, description } = req.body || {};
    if (typeof title !== "string" || title.trim().length < 3) {
      return res.status(400).json({ message: "Title must contain at least 3 characters." });
    }
    if (typeof description !== "string" || description.trim().length < 10) {
      return res.status(400).json({ message: "Description must contain at least 10 characters." });
    }
    const [result] = await pool.execute(
      "INSERT INTO complaints (user_id, title, description) VALUES (?, ?, ?)",
      [req.user.id, title.trim(), description.trim()]
    );
    const [rows] = await pool.execute("SELECT * FROM complaints WHERE id = ?", [result.insertId]);
    res.status(201).json({ message: "Complaint submitted successfully.", complaint: rows[0] });
  } catch (err) {
    next(err);
  }
});

// Feature 4 + 7: View own complaints with search/status filtering.
app.get("/api/complaints", authRequired, async (req, res, next) => {
  try {
    const { status, search } = req.query;
    const where = ["user_id = ?"];
    const params = [req.user.id];

    if (status) {
      const allowed = ["Pending", "In Progress", "Resolved"];
      if (!allowed.includes(status)) {
        return res.status(400).json({ message: "Invalid status. Use Pending, In Progress, or Resolved." });
      }
      where.push("status = ?");
      params.push(status);
    }
    if (search) {
      where.push("(title LIKE ? OR description LIKE ?)");
      params.push(`%${String(search).slice(0, 100)}%`, `%${String(search).slice(0, 100)}%`);
    }

    const [rows] = await pool.execute(
      `SELECT id, user_id, title, description, status, created_at, updated_at
       FROM complaints WHERE ${where.join(" AND ")} ORDER BY created_at DESC`,
      params
    );
    res.json({ count: rows.length, complaints: rows });
  } catch (err) {
    next(err);
  }
});

// Feature 5: User can edit their own complaint only while it is Pending.
app.put("/api/complaints/:id", authRequired, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: "Complaint ID must be a positive integer." });

    const { title, description } = req.body || {};
    if (typeof title !== "string" || title.trim().length < 3 ||
        typeof description !== "string" || description.trim().length < 10) {
      return res.status(400).json({ message: "Provide a title (at least 3 characters) and description (at least 10 characters)." });
    }

    const [result] = await pool.execute(
      `UPDATE complaints SET title = ?, description = ?
       WHERE id = ? AND user_id = ? AND status = 'Pending'`,
      [title.trim(), description.trim(), id, req.user.id]
    );
    if (!result.affectedRows) {
      const [rows] = await pool.execute("SELECT id, user_id, status FROM complaints WHERE id = ?", [id]);
      if (!rows.length) return res.status(404).json({ message: "Complaint not found." });
      if (rows[0].user_id !== req.user.id) return res.status(403).json({ message: "You can update only your own complaints." });
      return res.status(409).json({ message: "Only Pending complaints can be edited." });
    }
    const [updated] = await pool.execute("SELECT * FROM complaints WHERE id = ?", [id]);
    res.json({ message: "Complaint updated successfully.", complaint: updated[0] });
  } catch (err) {
    next(err);
  }
});

// Feature 6: Admin updates a complaint's status.
app.patch("/api/admin/complaints/:id/status", authRequired, adminRequired, async (req, res, next) => {
  const id = Number(req.params.id);
  const { status } = req.body || {};
  const allowed = ["Pending", "In Progress", "Resolved"];
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: "Complaint ID must be a positive integer." });
  if (!allowed.includes(status)) {
    return res.status(400).json({ message: "Status must be Pending, In Progress, or Resolved." });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT c.id, c.title, c.status, c.user_id, u.email AS user_email
       FROM complaints c JOIN users u ON u.id = c.user_id
       WHERE c.id = ? FOR UPDATE`,
      [id]
    );
    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ message: "Complaint not found." });
    }
    const complaint = rows[0];
    await connection.execute("UPDATE complaints SET status = ? WHERE id = ?", [status, id]);
    await recordAdminAudit(connection, req, {
      action: "complaint.status_updated",
      entityType: "complaint",
      entityId: id,
      details: {
        title: complaint.title,
        userId: complaint.user_id,
        userEmail: complaint.user_email,
        previousStatus: complaint.status,
        newStatus: status
      }
    });
    await connection.commit();
    const [updated] = await connection.execute("SELECT * FROM complaints WHERE id = ?", [id]);
    res.json({ message: "Complaint status updated successfully.", complaint: updated[0] });
  } catch (err) {
    if (connection) await connection.rollback();
    next(err);
  } finally {
    if (connection) connection.release();
  }
});

// Admin can see/search/filter all complaints (also useful for the admin screen/API).
app.get("/api/admin/complaints", authRequired, adminRequired, async (req, res, next) => {
  try {
    const { status, search } = req.query;
    const where = [];
    const params = [];
    const allowed = ["Pending", "In Progress", "Resolved"];
    if (status) {
      if (!allowed.includes(status)) return res.status(400).json({ message: "Invalid status." });
      where.push("c.status = ?");
      params.push(status);
    }
    if (search) {
      where.push("(c.title LIKE ? OR c.description LIKE ? OR u.name LIKE ? OR u.email LIKE ?)");
      const term = `%${String(search).slice(0, 100)}%`;
      params.push(term, term, term, term);
    }
    const sql = `
      SELECT c.id, c.user_id, u.name AS user_name, u.email AS user_email,
             c.title, c.description, c.status, c.created_at, c.updated_at
      FROM complaints c JOIN users u ON u.id = c.user_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY c.created_at DESC`;
    const [rows] = await pool.execute(sql, params);
    res.json({ count: rows.length, complaints: rows });
  } catch (err) {
    next(err);
  }
});

app.delete("/api/admin/complaints/:id", authRequired, adminRequired, async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ message: "Complaint ID must be a positive integer." });
  }
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT c.id, c.title, c.status, c.user_id, u.email AS user_email
       FROM complaints c JOIN users u ON u.id = c.user_id
       WHERE c.id = ? FOR UPDATE`,
      [id]
    );
    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ message: "Complaint not found." });
    }
    const complaint = rows[0];
    await connection.execute("DELETE FROM complaints WHERE id = ?", [id]);
    await recordAdminAudit(connection, req, {
      action: "complaint.deleted",
      entityType: "complaint",
      entityId: id,
      details: {
        title: complaint.title,
        userId: complaint.user_id,
        userEmail: complaint.user_email,
        status: complaint.status
      }
    });
    await connection.commit();
    res.json({ message: "Complaint deleted successfully." });
  } catch (err) {
    if (connection) await connection.rollback();
    next(err);
  } finally {
    if (connection) connection.release();
  }
});

app.get("/api/admin/users", authRequired, adminRequired, async (req, res, next) => {
  try {
    const search = String(req.query.search || "").slice(0, 100);
    const params = [];
    let where = "";
    if (search) {
      where = "WHERE name LIKE ? OR email LIKE ?";
      params.push(`%${search}%`, `%${search}%`);
    }
    const [rows] = await pool.execute(
      `SELECT id, name, email, role, is_active, created_at
       FROM users ${where}
       ORDER BY created_at DESC`,
      params
    );
    res.json({ count: rows.length, users: rows });
  } catch (err) {
    next(err);
  }
});

app.get("/api/admin/audit-logs", authRequired, adminRequired, async (req, res, next) => {
  try {
    const limitValue = Number(req.query.limit || 50);
    const offsetValue = Number(req.query.offset || 0);
    if (!Number.isInteger(limitValue) || limitValue < 1 ||
        !Number.isInteger(offsetValue) || offsetValue < 0) {
      return res.status(400).json({ message: "Limit and offset must be valid non-negative integers; limit must be at least 1." });
    }
    const limit = Math.min(limitValue, 100);
    const search = String(req.query.search || "").slice(0, 100);
    const params = [];
    let where = "";
    if (search) {
      where = "WHERE admin_email LIKE ? OR action LIKE ? OR entity_type LIKE ?";
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const [rows] = await pool.execute(
      `SELECT id, admin_id, admin_email, action, entity_type, entity_id, details, created_at
       FROM admin_audit_logs ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offsetValue]
    );
    const [totals] = await pool.execute(
      `SELECT COUNT(*) AS total FROM admin_audit_logs ${where}`,
      params
    );
    res.json({
      count: rows.length,
      total: totals[0].total,
      limit,
      offset: offsetValue,
      logs: rows.map((row) => ({
        ...row,
        details: typeof row.details === "string" ? JSON.parse(row.details) : row.details
      }))
    });
  } catch (err) {
    next(err);
  }
});

app.patch("/api/admin/users/:id/role", authRequired, adminRequired, async (req, res, next) => {
  const id = Number(req.params.id);
  const { role } = req.body || {};
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ message: "User ID must be a positive integer." });
  }
  if (!["user", "admin"].includes(role)) {
    return res.status(400).json({ message: "Role must be user or admin." });
  }
  if (id === Number(req.user.id) && role !== "admin") {
    return res.status(409).json({ message: "You cannot remove your own admin role." });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [users] = await connection.execute(
      "SELECT id, email, role, is_active FROM users WHERE id = ? FOR UPDATE",
      [id]
    );
    if (!users.length) {
      await connection.rollback();
      return res.status(404).json({ message: "User not found." });
    }
    if (users[0].role === "admin" && users[0].is_active && role !== "admin") {
      const [admins] = await connection.execute(
        "SELECT id FROM users WHERE role = 'admin' AND is_active = 1 FOR UPDATE"
      );
      if (admins.length <= 1) {
        await connection.rollback();
        return res.status(409).json({ message: "At least one active administrator must remain." });
      }
    }
    await connection.execute("UPDATE users SET role = ? WHERE id = ?", [role, id]);
    await recordAdminAudit(connection, req, {
      action: "user.role_updated",
      entityType: "user",
      entityId: id,
      details: {
        email: users[0].email,
        previousRole: users[0].role,
        newRole: role
      }
    });
    await connection.commit();
    res.json({ message: "User role updated successfully.", user: { id, role } });
  } catch (err) {
    if (connection) await connection.rollback();
    next(err);
  } finally {
    if (connection) connection.release();
  }
});

app.patch("/api/admin/users/:id/active", authRequired, adminRequired, async (req, res, next) => {
  const id = Number(req.params.id);
  const { active } = req.body || {};
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ message: "User ID must be a positive integer." });
  }
  if (typeof active !== "boolean") {
    return res.status(400).json({ message: "Active must be true or false." });
  }
  if (id === Number(req.user.id) && !active) {
    return res.status(409).json({ message: "You cannot deactivate your own account." });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [users] = await connection.execute(
      "SELECT id, role, is_active FROM users WHERE id = ? FOR UPDATE",
      [id]
    );
    if (!users.length) {
      await connection.rollback();
      return res.status(404).json({ message: "User not found." });
    }
    if (users[0].role === "admin" && users[0].is_active && !active) {
      const [admins] = await connection.execute(
        "SELECT id FROM users WHERE role = 'admin' AND is_active = 1 FOR UPDATE"
      );
      if (admins.length <= 1) {
        await connection.rollback();
        return res.status(409).json({ message: "At least one active administrator must remain." });
      }
    }
    await connection.execute("UPDATE users SET is_active = ? WHERE id = ?", [active, id]);
    await recordAdminAudit(connection, req, {
      action: active ? "user.reactivated" : "user.deactivated",
      entityType: "user",
      entityId: id,
      details: {
        previousActive: Boolean(users[0].is_active),
        newActive: active
      }
    });
    await connection.commit();
    res.json({
      message: active ? "User account reactivated." : "User account deactivated.",
      user: { id, is_active: active }
    });
  } catch (err) {
    if (connection) await connection.rollback();
    next(err);
  } finally {
    if (connection) connection.release();
  }
});

// Central error handler.
app.use((err, _req, res, _next) => {
  console.error(err);
  if (err.code === "ER_BAD_DB_ERROR" || err.code === "ECONNREFUSED" || err.code === "ER_ACCESS_DENIED_ERROR") {
    return res.status(503).json({
      message: "Database connection failed. Check MySQL is running and your .env credentials/database name are correct.",
      detail: err.code
    });
  }
  res.status(500).json({ message: "Something went wrong on the server." });
});

async function start() {
  try {
    await pool.query("SELECT 1");
    await ensureUserStatusColumn();
    await ensureAdminAuditTable();
    console.log("MySQL connected successfully.");
    app.listen(PORT, () => {
      console.log(`Smart Complaint Management API running at http://localhost:${PORT}`);
      console.log("Use README.md for API routes and setup.");
    });
  } catch (err) {
    console.error("Could not connect to MySQL:", err.code || err.message);
    console.error("Check MySQL service, schema.sql, and .env settings.");
    process.exit(1);
  }
}

start();
