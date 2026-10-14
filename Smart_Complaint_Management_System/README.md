# Smart Complaint Management System

Beginner-friendly internship project built with **Node.js, Express.js, and MySQL**.

## Features

1. User registration
2. User login (JWT)
3. Submit complaint
4. View your complaints
5. Update your own Pending complaint
6. Admin complaint dashboard for search, filtering, and status updates
7. Search/filter complaints
8. Admin user directory, role management, and account deactivation/reactivation
9. Admin complaint deletion
10. Permanent audit history of administrator changes

The project includes a lightweight browser interface for account registration/login,
complaint submission, and viewing complaint status.

## Requirements

- Node.js 18+ (recommended)
- MySQL Server (MySQL Workbench is optional)
- VS Code
- Postman (for testing APIs)

## 1. Open the project

Extract the ZIP file, then open the `Smart_Complaint_Management_System` folder in VS Code.

## 2. Create the MySQL database

Open MySQL Workbench or the MySQL command line and run the entire file:

`db/schema.sql`

It creates the `complaint_management` database and the `users` and `complaints` tables.

Command-line alternative (run from the project folder; adjust credentials if needed):

```bash
mysql -u root -p < db/schema.sql
```

## 3. Configure environment variables

Copy `.env.example` to a new file named `.env`.

Update these values with your own MySQL settings:

```env
PORT=3000
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=complaint_management
JWT_SECRET=use_a_long_random_secret_here
```

Do not share or commit `.env`. Public registration can only create `user` accounts. To create an admin for local practice, use the optional bootstrap instructions below.

## 4. Install dependencies and run

Open the VS Code terminal in the project folder:

```bash
npm install
npm start
```

When successful, the terminal says the API is running at `http://localhost:3000`.

Open `http://localhost:3000` in a browser to use the complaint management interface.
Check `http://localhost:3000/api/health` to verify the database connection.

## 5. Create an admin account (local development)

The app deliberately does not allow a user to choose `role: "admin"` during public registration.

Register a normal account through `/api/auth/register`, then promote it manually in MySQL for local practice:

```sql
USE complaint_management;
UPDATE users SET role = 'admin' WHERE email = 'admin@example.com';
```

Use the same email you registered. Then log in again to receive a token containing the admin role. Change the example email to your actual account email.

After an administrator logs in at `http://localhost:3000`, the Admin control panel appears below the regular complaint area. It can search and filter complaints, change their status, delete complaints, search user accounts, change user/admin roles, deactivate/reactivate accounts, and inspect a paginated activity history. User accounts are not permanently deleted. At least one active administrator must remain, and an administrator cannot disable or demote their own account.

All admin changes are committed to MySQL. Each complaint status change/deletion and each user role/access change writes an audit record in the same database transaction, so a failed audit write also rolls back the requested change. Deleting a complaint permanently removes the complaint itself; its audit entry remains and records its ID, title, owner, and last status (not the complaint description). There is no admin user-account deletion action.

The server automatically adds the `users.is_active` column and creates the audit-log table for an existing database on startup. New databases also get these from `db/schema.sql`.

## API routes

Base URL: `http://localhost:3000`

| Method | Route | Login? | Purpose |
|---|---|---|---|
| GET | `/` | No | API welcome message |
| GET | `/api` | No | List the API status and main endpoints |
| GET | `/api/health` | No | Check server/database |
| POST | `/api/auth/register` | No | Register user |
| POST | `/api/auth/login` | No | Login and receive JWT |
| POST | `/api/complaints` | Yes | Submit a complaint |
| GET | `/api/complaints` | Yes | View your complaints; supports `status` and `search` |
| PUT | `/api/complaints/:id` | Yes | Edit your own Pending complaint |
| GET | `/api/admin/complaints` | Admin | View/search/filter all complaints |
| PATCH | `/api/admin/complaints/:id/status` | Admin | Update complaint status |
| DELETE | `/api/admin/complaints/:id` | Admin | Permanently delete a complaint |
| GET | `/api/admin/users` | Admin | Search/list user accounts |
| PATCH | `/api/admin/users/:id/role` | Admin | Change a user's role |
| PATCH | `/api/admin/users/:id/active` | Admin | Deactivate/reactivate a user account |
| GET | `/api/admin/audit-logs` | Admin | Search and page through permanent admin activity history |

### Status values

Use exactly one of:

- `Pending`
- `In Progress`
- `Resolved`

### Example request bodies

Register (`POST /api/auth/register`):
```json
{
  "name": "Tej",
  "email": "tej@example.com",
  "password": "StrongPass123"
}
```

Login (`POST /api/auth/login`):
```json
{
  "email": "tej@example.com",
  "password": "StrongPass123"
}
```

Submit complaint (`POST /api/complaints`):
```json
{
  "title": "Internet is not working",
  "description": "My internet connection has been down since this morning."
}
```

Edit complaint (`PUT /api/complaints/1`):
```json
{
  "title": "Internet connection issue",
  "description": "The connection is still not working after restarting the router."
}
```

Update status as admin (`PATCH /api/admin/complaints/1/status`):
```json
{
  "status": "In Progress"
}
```

### Search and filter examples

Your own complaints:
- `GET /api/complaints?status=Pending`
- `GET /api/complaints?search=internet`
- `GET /api/complaints?status=Resolved&search=network`

Admin complaints:
- `GET /api/admin/complaints?status=Pending`
- `GET /api/admin/complaints?search=tej`
- `GET /api/admin/complaints?status=In%20Progress&search=internet`

For every protected request, add this header in Postman:

`Authorization: Bearer YOUR_TOKEN_HERE`

## Beginner notes

- **REST API:** endpoints clients call using HTTP methods like GET, POST, PUT, PATCH.
- **CRUD:** Create, Read, Update, Delete. This project demonstrates Create, Read, and Update operations.
- **JWT:** a signed token used to identify a logged-in user.
- **Parameterized SQL:** `?` placeholders help prevent SQL injection for user-supplied values.
- Users can only see/edit their own complaints. Admin-only routes require an admin token.
- The project is intended for local learning. Before production use, add automated tests, rate limiting, stronger deployment configuration, and other operational controls.

## Common problems

- `ECONNREFUSED`: start the MySQL service and check `DB_HOST`.
- `ER_ACCESS_DENIED_ERROR`: check `DB_USER` and `DB_PASSWORD`.
- `ER_BAD_DB_ERROR`: run `db/schema.sql` and verify `DB_NAME`.
- `EADDRINUSE`: another app is using port 3000; change `PORT` in `.env`.
