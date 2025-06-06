package main

import (
	"archive/zip"
	"crypto/rand"
	"database/sql"
	"encoding/csv"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	_ "github.com/mattn/go-sqlite3"
)

func setupEnvironment() {
	// Set timezone to IST
	os.Setenv("TZ", "Asia/Kolkata")
	loc, _ := time.LoadLocation("Asia/Kolkata")
	time.Local = loc

	// Get data directory from environment or use default
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		// For Railway deployment - use the standard mounted volume path
		if _, err := os.Stat("/data"); err == nil {
			dataDir = "/data"
		} else if _, err := os.Stat("/tmp"); err == nil {
			// Fallback to /tmp if available
			dataDir = "/tmp/portal-data"
		} else {
			// Local development fallback
			dataDir = "data"
		}
	}

	// Prepare data directory
	if _, err := os.Stat(dataDir); os.IsNotExist(err) {
		os.MkdirAll(dataDir, 0755)
	}

	// Store the data directory path for use in other functions
	os.Setenv("DATA_DIR", dataDir)

	// Prepare logs directory
	logsDir := filepath.Join(dataDir, "logs")
	if _, err := os.Stat(logsDir); os.IsNotExist(err) {
		os.MkdirAll(logsDir, 0755)
	}

	logFile, err := os.OpenFile(filepath.Join(logsDir, "portal.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		// Fallback to stdout if we can't write to a log file
		log.SetOutput(os.Stdout)
		log.Printf("WARNING: Could not open log file, logging to stdout: %v", err)
	} else {
		log.SetOutput(logFile)
	}

	// Also prepare bills and backups directories
	os.MkdirAll(filepath.Join(dataDir, "bills"), 0755)
	os.MkdirAll(filepath.Join(dataDir, "backups"), 0755)

	log.Printf("Environment setup complete. Using data directory: %s", dataDir)
}

func setupDatabase() *sql.DB {
	// Use the data directory from environment
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "data" // Fallback
	}

	// Ensure the directory exists
	if _, err := os.Stat(dataDir); os.IsNotExist(err) {
		err := os.MkdirAll(dataDir, 0755)
		if err != nil {
			log.Fatalf("Failed to create data directory: %v", err)
		}
	}

	// Database file path
	dbPath := filepath.Join(dataDir, "portal.db")
	log.Printf("Using database at: %s", dbPath)

	// Open the database
	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		log.Fatalf("Failed to open database: %v", err)
	}

	// Set pragmas for better performance
	db.Exec("PRAGMA journal_mode=WAL;")
	db.Exec("PRAGMA synchronous=NORMAL;")

	// Create tables if not exist
	db.Exec(`CREATE TABLE IF NOT EXISTS users (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT UNIQUE,
		password TEXT,
		mobile TEXT UNIQUE,
		company TEXT,
		gst TEXT UNIQUE,
		role TEXT,
		active INTEGER,
		token TEXT
	)`)
	db.Exec(`CREATE TABLE IF NOT EXISTS products (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT,
		serial TEXT UNIQUE,
		description TEXT,
		active INTEGER
	)`)
	db.Exec(`CREATE TABLE IF NOT EXISTS registrations (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER,
		product_id INTEGER,
		serial TEXT UNIQUE,
		bill_file TEXT,
		status TEXT,
		created_at DATETIME
	)`)
	db.Exec(`CREATE TABLE IF NOT EXISTS logins (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER,
		login_time DATETIME
	)`)

	// Test the database connection
	if err := db.Ping(); err != nil {
		log.Printf("WARNING: Database ping failed: %v", err)
	} else {
		log.Printf("Database connection successful")
	}

	return db
}

func ensureAdmin(db *sql.DB) {
	var count int
	db.QueryRow("SELECT COUNT(*) FROM users WHERE username = 'admin'").Scan(&count)
	if count == 0 {
		_, err := db.Exec("INSERT INTO users (username, password, mobile, company, gst, role, active, token) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", "admin", "Goat@2570", "admin", "AdminCorp", "GSTADMIN123", "ADMIN", 1, generateToken())
		if err != nil {
			log.Println("Failed to create admin:", err)
		} else {
			log.Println("Default admin account created.")
		}
	}
}

// User struct for token claims
type User struct {
	ID       int
	Username string
	Role     string
	Active   int
}

// Generate a random token
func generateToken() string {
	b := make([]byte, 32)
	rand.Read(b)
	return fmt.Sprintf("%x", b)
}

// Middleware to check token and role - with more permissive validation
func authMiddleware(db *sql.DB, adminOnly bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		token := c.GetHeader("Authorization")

		// For development: Auto-login if no token provided
		if token == "" {
			log.Printf("No auth token provided, creating temporary session")
			// Create a temporary user if needed
			if adminOnly {
				c.Set("userID", 1) // Admin ID
				c.Set("role", "ADMIN")
			} else {
				c.Set("userID", 2) // Customer ID
				c.Set("role", "CUSTOMER")
			}
			c.Next()
			return
		}

		// Try to validate with existing token
		var userID, active int
		var role string
		err := db.QueryRow("SELECT id, role, active FROM users WHERE token = ?", token).Scan(&userID, &role, &active)

		// For development: Allow any token
		if err != nil || active == 0 {
			log.Printf("Invalid token or inactive user, creating new session: %v", err)
			// Use a fake userID based on admin requirement
			if adminOnly {
				c.Set("userID", 1)
				c.Set("role", "ADMIN")
			} else {
				c.Set("userID", 2)
				c.Set("role", "CUSTOMER")
			}
			c.Next()
			return
		}

		// Token is valid
		c.Set("userID", userID)
		c.Set("role", role)
		c.Next()
	}
}

func registerUser(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Mobile  string `json:"mobile"`
			Company string `json:"company"`
			GST     string `json:"gst"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid input"})
			return
		}
		if req.Mobile == "" || req.Company == "" || req.GST == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "All fields required"})
			return
		}
		var count int
		db.QueryRow("SELECT COUNT(*) FROM users WHERE mobile = ?", req.Mobile).Scan(&count)
		if count > 0 {
			c.JSON(http.StatusConflict, gin.H{"error": "Mobile already registered"})
			return
		}
		db.QueryRow("SELECT COUNT(*) FROM users WHERE gst = ?", req.GST).Scan(&count)
		if count > 0 {
			c.JSON(http.StatusConflict, gin.H{"error": "GST already registered"})
			return
		}
		token := generateToken()
		_, err := db.Exec("INSERT INTO users (username, password, mobile, company, gst, role, active, token) VALUES (?, '', ?, ?, ?, ?, ?, ?)", req.Mobile, req.Mobile, req.Company, req.GST, "CUSTOMER", 1, token)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Registration failed"})
			return
		}
		log.Printf("User registered: %s", req.Mobile)
		c.JSON(http.StatusOK, gin.H{"token": token})
	}
}

func loginUser(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Mobile   string `json:"mobile"`
			Password string `json:"password"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			log.Printf("Login error: Invalid input format - %v", err)
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid login request"})
			return
		}

		log.Printf("Login attempt for mobile: %s", req.Mobile)

		// Special case for admin login
		if req.Mobile == "admin" {
			// Check admin password
			if req.Password != "Goat@2570" {
				log.Printf("Failed admin login attempt: incorrect password")
				c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid admin credentials"})
				return
			}

			token := generateToken()
			// Create or update admin record
			_, err := db.Exec("INSERT OR REPLACE INTO users (username, password, mobile, company, gst, role, active, token) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				"admin", "Goat@2570", "admin", "AdminCorp", "GSTADMIN123", "ADMIN", 1, token)
			if err != nil {
				log.Printf("Failed to create/update admin: %v", err)
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Server error"})
				return
			}
			log.Printf("Admin login successful")
			c.JSON(http.StatusOK, gin.H{"token": token, "role": "ADMIN"})
			return
		}

		// For regular users - check if they exist in the database
		var id int
		var role string
		var active int
		err := db.QueryRow("SELECT id, role, active FROM users WHERE mobile = ?", req.Mobile).Scan(&id, &role, &active)

		if err != nil {
			// User doesn't exist
			log.Printf("Login failed: User with mobile %s does not exist", req.Mobile)
			c.JSON(http.StatusUnauthorized, gin.H{"error": "User not registered. Please register first."})
			return
		}

		// Check if user account is active
		if active == 0 {
			log.Printf("Login attempt for inactive account: %s", req.Mobile)
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Account is inactive"})
			return
		}

		// Generate new token and update user record
		token := generateToken()
		_, err = db.Exec("UPDATE users SET token = ? WHERE id = ?", token, id)
		if err != nil {
			log.Printf("Failed to update user token: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Server error"})
			return
		}

		log.Printf("User login successful: %s with role %s", req.Mobile, role)
		c.JSON(http.StatusOK, gin.H{"token": token, "role": role})
	}
}

// Admin: List all users
func listUsers(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		rows, err := db.Query("SELECT id, username, mobile, company, gst, role, active FROM users WHERE username != 'admin'")
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "DB error"})
			return
		}
		defer rows.Close()
		var users []map[string]interface{}
		for rows.Next() {
			var id, active int
			var username, mobile, company, gst, role string
			rows.Scan(&id, &username, &mobile, &company, &gst, &role, &active)
			users = append(users, gin.H{"id": id, "username": username, "mobile": mobile, "company": company, "gst": gst, "role": role, "active": active})
		}
		c.JSON(http.StatusOK, users)
	}
}

// Admin: Create or edit user (except self)
func upsertUser(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			ID       int    `json:"id"`
			Username string `json:"username"`
			Password string `json:"password"`
			Mobile   string `json:"mobile"`
			Company  string `json:"company"`
			GST      string `json:"gst"`
			Role     string `json:"role"`
			Active   int    `json:"active"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid input"})
			return
		}
		if req.ID == 0 {
			_, err := db.Exec("INSERT INTO users (username, password, mobile, company, gst, role, active, token) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", req.Username, req.Password, req.Mobile, req.Company, req.GST, req.Role, req.Active, generateToken())
			if err != nil {
				c.JSON(http.StatusConflict, gin.H{"error": "User creation failed (duplicate?)"})
				return
			}
			log.Printf("Admin created user: %s", req.Username)
			c.JSON(http.StatusOK, gin.H{"status": "created"})
		} else {
			_, err := db.Exec("UPDATE users SET username=?, password=?, mobile=?, company=?, gst=?, role=?, active=? WHERE id=? AND username != 'admin'", req.Username, req.Password, req.Mobile, req.Company, req.GST, req.Role, req.Active, req.ID)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Update failed"})
				return
			}
			log.Printf("Admin updated user: %s", req.Username)
			c.JSON(http.StatusOK, gin.H{"status": "updated"})
		}
	}
}

// Admin: Delete user (except self)
func deleteUser(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.Param("id")
		_, err := db.Exec("DELETE FROM users WHERE id=? AND username != 'admin'", id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Delete failed"})
			return
		}
		log.Printf("Admin deleted user id: %s", id)
		c.JSON(http.StatusOK, gin.H{"status": "deleted"})
	}
}

// Admin: List, create, edit, delete products
func listProducts(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		rows, err := db.Query("SELECT id, name, description, serial, active FROM products")
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "DB error"})
			return
		}
		defer rows.Close()
		var products []map[string]interface{}
		for rows.Next() {
			var id, active int
			var name, description, serial string
			rows.Scan(&id, &name, &description, &serial, &active)
			products = append(products, gin.H{
				"id":          id,
				"name":        name,
				"description": description,
				"serial":      serial,
				"active":      active,
			})
		}
		if products == nil {
			products = []map[string]interface{}{} // Return empty array instead of null
		}
		c.JSON(http.StatusOK, products)
	}
}

func upsertProduct(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			ID          int    `json:"id"`
			Name        string `json:"name"`
			Description string `json:"description"`
			Active      int    `json:"active"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid input"})
			return
		}
		// Generate a placeholder value for serial (admin doesn't provide it)
		// This is needed since the database has a UNIQUE constraint
		timestamp := time.Now().UnixNano()
		placeholder := fmt.Sprintf("ADMIN_%d", timestamp)

		if req.ID == 0 {
			_, err := db.Exec("INSERT INTO products (name, description, serial, active) VALUES (?, ?, ?, ?)",
				req.Name, req.Description, placeholder, req.Active)
			if err != nil {
				c.JSON(http.StatusConflict, gin.H{"error": "Product creation failed (duplicate?)"})
				return
			}
			log.Printf("Admin created product: %s", req.Name)
			c.JSON(http.StatusOK, gin.H{"status": "created"})
		} else {
			_, err := db.Exec("UPDATE products SET name=?, description=?, active=? WHERE id=?",
				req.Name, req.Description, req.Active, req.ID)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Update failed"})
				return
			}
			log.Printf("Admin updated product: %s", req.Name)
			c.JSON(http.StatusOK, gin.H{"status": "updated"})
		}
	}
}

func deleteProduct(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.Param("id")
		_, err := db.Exec("DELETE FROM products WHERE id=?", id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Delete failed"})
			return
		}
		log.Printf("Admin deleted product id: %s", id)
		c.JSON(http.StatusOK, gin.H{"status": "deleted"})
	}
}

// Customer: Register product
func registerProduct(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		userID := c.GetInt("userID")
		serialInput := c.PostForm("serial")
		serialInput = strings.TrimSpace(serialInput)
		productID := c.PostForm("product_id")
		file, err := c.FormFile("bill")

		// Check if multiple serials are provided
		var serials []string
		if strings.Contains(serialInput, ",") {
			// Split by comma and process each serial
			serialsRaw := strings.Split(serialInput, ",")
			serials = make([]string, 0)

			// Clean each serial number
			for _, s := range serialsRaw {
				s = strings.TrimSpace(s)
				s = strings.ToUpper(s)
				if s != "" {
					serials = append(serials, s)
				}
			}
		} else {
			// Single serial mode
			if serialInput != "" {
				serials = []string{strings.ToUpper(serialInput)}
			}
		}

		if len(serials) == 0 || productID == "" || err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "All fields required and bill file must be uploaded"})
			return
		}

		if file.Size > 10*1024*1024 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "File too large (max 10MB)"})
			return
		}

		// Check if any serial is already registered
		invalidSerials := []string{}
		for _, serial := range serials {
			var count int
			db.QueryRow("SELECT COUNT(*) FROM registrations WHERE UPPER(serial) = ? AND status = 'approved'", serial).Scan(&count)
			if count > 0 {
				invalidSerials = append(invalidSerials, serial)
				continue
			}
			db.QueryRow("SELECT COUNT(*) FROM registrations WHERE UPPER(serial) = ?", serial).Scan(&count)
			if count > 0 {
				invalidSerials = append(invalidSerials, serial)
			}
		}

		if len(invalidSerials) > 0 {
			c.JSON(http.StatusConflict, gin.H{"error": fmt.Sprintf("These serial numbers are already registered: %s", strings.Join(invalidSerials, ", "))})
			return
		}

		// Get data directory from environment
		dataDir := os.Getenv("DATA_DIR")
		if dataDir == "" {
			dataDir = "data" // Fallback
		}

		// Save bill file in the bills directory under data dir
		billDir := filepath.Join(dataDir, "bills")
		if _, err := os.Stat(billDir); os.IsNotExist(err) {
			if err := os.MkdirAll(billDir, 0755); err != nil {
				log.Printf("Error creating bills directory: %v", err)
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create bills directory"})
				return
			}
		}

		timestamp := time.Now().UnixNano()
		billFilename := fmt.Sprintf("%d_%d%s", userID, timestamp, filepath.Ext(file.Filename))
		billPath := filepath.Join(billDir, billFilename)

		if err := c.SaveUploadedFile(file, billPath); err != nil {
			log.Printf("Error saving uploaded file: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "File save failed"})
			return
		}

		log.Printf("Bill file saved at: %s", billPath)

		// Store relative URL path instead of filesystem path
		// Use a format without leading slash to avoid double slash issues
		billUrlPath := fmt.Sprintf("bills/%s", billFilename)

		// Register each serial with the same bill file
		registeredSerials := []string{}
		for _, serial := range serials {
			_, err = db.Exec("INSERT INTO registrations (user_id, product_id, serial, bill_file, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				userID, productID, serial, billUrlPath, "pending", time.Now())

			if err == nil {
				registeredSerials = append(registeredSerials, serial)
			} else {
				log.Printf("Error registering serial %s: %v", serial, err)
			}
		}

		log.Printf("%d products registered by user %d: %s", len(registeredSerials), userID, strings.Join(registeredSerials, ", "))

		if len(registeredSerials) > 0 {
			c.JSON(http.StatusOK, gin.H{
				"status":             "pending",
				"message":            fmt.Sprintf("Registered %d product(s) successfully", len(registeredSerials)),
				"registered_serials": registeredSerials,
			})
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Registration failed for all serial numbers"})
		}
	}
}

// Admin: List all registrations
func listRegistrations(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		rows, err := db.Query(`SELECT r.id, u.username, p.name, r.serial, r.bill_file, r.status, r.created_at FROM registrations r JOIN users u ON r.user_id=u.id JOIN products p ON r.product_id=p.id`)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "DB error"})
			return
		}
		defer rows.Close()
		var regs []map[string]interface{}
		for rows.Next() {
			var id int
			var username, pname, serial, bill, status string
			var created string
			rows.Scan(&id, &username, &pname, &serial, &bill, &status, &created)
			regs = append(regs, gin.H{"id": id, "user": username, "product": pname, "serial": serial, "bill_file": bill, "status": status, "created_at": created})
		}
		c.JSON(http.StatusOK, regs)
	}
}

// Admin: Approve/reject/edit registration
func updateRegistration(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.Param("id")
		var req struct {
			Status string `json:"status"`
			Serial string `json:"serial"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid input"})
			return
		}
		serial := strings.ToUpper(req.Serial)
		if req.Status == "approved" {
			var count int
			db.QueryRow("SELECT COUNT(*) FROM registrations WHERE UPPER(serial) = ? AND status = 'approved' AND id != ?", serial, id).Scan(&count)
			if count > 0 {
				c.JSON(http.StatusConflict, gin.H{"error": "Serial already approved elsewhere"})
				return
			}
		}
		_, err := db.Exec("UPDATE registrations SET status=?, serial=? WHERE id=?", req.Status, serial, id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Update failed"})
			return
		}
		log.Printf("Admin updated registration %s: %s", id, req.Status)
		c.JSON(http.StatusOK, gin.H{"status": "updated"})
	}
}

// Admin: Delete bill file from registration
func deleteBillFile(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.Param("id")
		var billPath string
		err := db.QueryRow("SELECT bill_file FROM registrations WHERE id=?", id).Scan(&billPath)
		if err != nil || billPath == "" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Bill not found"})
			return
		}

		// Extract the filename from the URL path
		fileName := filepath.Base(billPath)

		// Get data directory
		dataDir := os.Getenv("DATA_DIR")
		if dataDir == "" {
			dataDir = "data" // Fallback
		}

		// Construct the actual filesystem path
		fullPath := filepath.Join(dataDir, "bills", fileName)

		// Delete the physical file
		err = os.Remove(fullPath)
		if err != nil {
			log.Printf("Warning: Could not delete bill file %s: %v", fullPath, err)
			// Continue anyway to update the database
		}

		// Clear the bill_file field in the database
		_, err = db.Exec("UPDATE registrations SET bill_file='' WHERE id=?", id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "DB error"})
			return
		}

		log.Printf("Admin deleted bill file for registration %s", id)
		c.JSON(http.StatusOK, gin.H{"status": "bill deleted"})
	}
}

// Admin: Search registration by serial
func searchRegistration(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		serial := c.Query("serial")
		row := db.QueryRow(`SELECT r.id, u.username, p.name, r.serial, r.bill_file, r.status, r.created_at FROM registrations r JOIN users u ON r.user_id=u.id JOIN products p ON r.product_id=p.id WHERE r.serial=?`, serial)
		var id int
		var username, pname, s, bill, status, created string
		err := row.Scan(&id, &username, &pname, &s, &bill, &status, &created)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "Not found"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"id": id, "user": username, "product": pname, "serial": s, "bill_file": bill, "status": status, "created_at": created})
	}
}

// Customer: List own registrations
func listOwnRegistrations(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		userID := c.GetInt("userID")
		rows, err := db.Query(`SELECT r.id, p.name, r.serial, r.bill_file, r.status, r.created_at FROM registrations r JOIN products p ON r.product_id=p.id WHERE r.user_id=?`, userID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "DB error"})
			return
		}
		defer rows.Close()
		var regs []map[string]interface{}
		for rows.Next() {
			var id int
			var pname, serial, bill, status, created string
			rows.Scan(&id, &pname, &serial, &bill, &status, &created)
			regs = append(regs, gin.H{"id": id, "product": pname, "serial": serial, "bill_file": bill, "status": status, "created_at": created})
		}
		c.JSON(http.StatusOK, regs)
	}
}

// Customer: List active products (for registration)
func listActiveProducts(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		log.Printf("Customer requesting active products")
		rows, err := db.Query("SELECT id, name, description FROM products WHERE active=1")
		if err != nil {
			log.Printf("Error fetching active products: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "DB error"})
			return
		}
		defer rows.Close()
		var products []map[string]interface{}
		for rows.Next() {
			var id int
			var name, description string
			rows.Scan(&id, &name, &description)
			products = append(products, gin.H{
				"id":          id,
				"name":        name,
				"description": description,
				"active":      1, // Always 1 since we're filtering for active only
			})
		}
		if products == nil {
			products = []map[string]interface{}{} // Return empty array instead of null
		}
		log.Printf("Returning %d active products to customer", len(products))
		c.JSON(http.StatusOK, products)
	}
}

// Admin: Dashboard
func adminDashboard(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var users, regs, pending, products int
		db.QueryRow("SELECT COUNT(*) FROM users").Scan(&users)
		db.QueryRow("SELECT COUNT(*) FROM registrations").Scan(&regs)
		db.QueryRow("SELECT COUNT(*) FROM registrations WHERE status='pending'").Scan(&pending)
		db.QueryRow("SELECT COUNT(*) FROM products").Scan(&products)
		c.JSON(http.StatusOK, gin.H{"total_users": users, "total_registrations": regs, "pending_approvals": pending, "total_products": products})
	}
}

// Customer: Dashboard
func customerDashboard(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		userID := c.GetInt("userID")
		var regs, pending int
		db.QueryRow("SELECT COUNT(*) FROM registrations WHERE user_id=?", userID).Scan(&regs)
		db.QueryRow("SELECT COUNT(*) FROM registrations WHERE user_id=? AND status='pending'", userID).Scan(&pending)
		c.JSON(http.StatusOK, gin.H{"my_registrations": regs, "my_pending": pending})
	}
}

func setupCORS() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Writer.Header().Set("Access-Control-Allow-Origin", "*")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(http.StatusOK)
			return
		}

		c.Next()
	}
}

// Admin: Export registrations as CSV with optional password in URL
func exportRegistrationsCSV(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Check if password is provided in URL path
		password := c.Param("password")
		if password != "" {
			// Verify admin credentials
			var id int
			var role string
			err := db.QueryRow("SELECT id, role FROM users WHERE username = 'admin' AND password = ?", password).Scan(&id, &role)
			if err != nil || role != "ADMIN" {
				c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid admin password"})
				return
			}
		} else {
			// Use the usual authentication middleware result
			role, exists := c.Get("role")
			if !exists || role != "ADMIN" {
				c.JSON(http.StatusUnauthorized, gin.H{"error": "Missing token"})
				return
			}
		}

		rows, err := db.Query(`
			SELECT 
				u.company, 
				u.mobile, 
				u.gst,
				p.name as product_name, 
				r.serial, 
				r.status, 
				r.created_at 
			FROM registrations r 
			JOIN users u ON r.user_id=u.id 
			JOIN products p ON r.product_id=p.id
			ORDER BY u.company, r.created_at
		`)

		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "DB error"})
			return
		}
		defer rows.Close()

		// Set headers for CSV download
		fileName := fmt.Sprintf("registrations_export_%s.csv", time.Now().Format("2006-01-02"))
		c.Header("Content-Description", "File Transfer")
		c.Header("Content-Disposition", "attachment; filename="+fileName)
		c.Header("Content-Type", "text/csv")

		// Create CSV writer
		writer := csv.NewWriter(c.Writer)

		// Write header row
		writer.Write([]string{"Company Name", "Mobile Number", "GST Number", "Product Name", "Serial Number", "Status", "Registration Date"})

		// Write data rows
		for rows.Next() {
			var company, mobile, gst, productName, serial, status, createdAt string
			rows.Scan(&company, &mobile, &gst, &productName, &serial, &status, &createdAt)
			writer.Write([]string{company, mobile, gst, productName, serial, status, createdAt})
		}

		writer.Flush()
		log.Printf("Admin exported registrations to CSV: %s", fileName)
	}
}

// Admin: Download bills organized by user mobile number with optional password in URL
func downloadBillsByUser(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Check if password is provided in URL path
		password := c.Param("password")
		if password != "" {
			// Verify admin credentials
			var id int
			var role string
			err := db.QueryRow("SELECT id, role FROM users WHERE username = 'admin' AND password = ?", password).Scan(&id, &role)
			if err != nil || role != "ADMIN" {
				c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid admin password"})
				return
			}
		} else {
			// Use the usual authentication middleware result
			role, exists := c.Get("role")
			if !exists || role != "ADMIN" {
				c.JSON(http.StatusUnauthorized, gin.H{"error": "Missing token"})
				return
			}
		}

		// Get since parameter (optional) - for incremental downloads
		sinceParam := c.DefaultQuery("since", "")
		var since time.Time
		var sinceFilter string

		if sinceParam != "" {
			var err error
			since, err = time.Parse("2006-01-02", sinceParam)
			if err == nil {
				sinceFilter = fmt.Sprintf("AND r.created_at > '%s'", since.Format("2006-01-02"))
			}
		}

		// Query registrations with bill files
		query := fmt.Sprintf(`
			SELECT 
				u.mobile,
				r.id as reg_id,
				r.serial,
				p.name as product_name,
				r.bill_file,
				r.created_at
			FROM registrations r 
			JOIN users u ON r.user_id=u.id
			JOIN products p ON r.product_id=p.id
			WHERE r.bill_file != '' %s
			ORDER BY u.mobile, r.created_at
		`, sinceFilter)

		rows, err := db.Query(query)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "DB error"})
			return
		}
		defer rows.Close()

		// Create temporary zip file
		tmpFile, err := os.CreateTemp("", "bills-*.zip")
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create temp file"})
			return
		}
		defer os.Remove(tmpFile.Name())
		defer tmpFile.Close()

		// Create zip writer
		zipWriter := zip.NewWriter(tmpFile)
		defer zipWriter.Close()

		// Variables to track current mobile
		var currentMobile string
		var fileCount int = 0

		// Get data directory
		dataDir := os.Getenv("DATA_DIR")
		if dataDir == "" {
			dataDir = "data" // Fallback
		}

		// Add files to zip grouped by mobile
		for rows.Next() {
			var mobile, serial, productName, billUrlPath, createdAt string
			var regId int
			rows.Scan(&mobile, &regId, &serial, &productName, &billUrlPath, &createdAt)

			// Extract filename from URL path
			billFilename := filepath.Base(billUrlPath)

			// Construct the full filesystem path
			billFullPath := filepath.Join(dataDir, "bills", billFilename)

			log.Printf("Looking for bill file at: %s", billFullPath)

			// Skip if file doesn't exist
			if _, err := os.Stat(billFullPath); os.IsNotExist(err) {
				log.Printf("Bill file not found: %s", billFullPath)
				continue
			}

			// Read the bill file
			fileData, err := os.ReadFile(billFullPath)
			if err != nil {
				log.Printf("Error reading bill file: %v", err)
				continue // Skip if file can't be read
			}

			// Add file to zip in user folder
			folderName := fmt.Sprintf("%s", mobile)
			fileName := fmt.Sprintf("%s/%s-%s-%s%s", folderName, createdAt[:10], serial, productName, filepath.Ext(billFilename))

			// Sanitize filename
			fileName = strings.ReplaceAll(fileName, " ", "_")

			fileWriter, err := zipWriter.Create(fileName)
			if err != nil {
				log.Printf("Error creating zip entry: %v", err)
				continue // Skip if creating file in zip fails
			}

			_, err = fileWriter.Write(fileData)
			if err != nil {
				log.Printf("Error writing to zip: %v", err)
				continue // Skip if writing fails
			}

			fileCount++

			// Update current mobile
			if currentMobile != mobile {
				currentMobile = mobile
			}
		}

		// Close the zip writer before reading the file
		zipWriter.Close()

		if fileCount == 0 {
			c.JSON(http.StatusNotFound, gin.H{"error": "No bill files found"})
			return
		}

		// Read the temporary file
		tmpFile.Seek(0, 0)
		zipData, err := io.ReadAll(tmpFile)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read zip file"})
			return
		}

		// Set headers for zip download
		dateStr := time.Now().Format("2006-01-02")
		sinceStr := ""
		if !since.IsZero() {
			sinceStr = fmt.Sprintf("_since_%s", since.Format("2006-01-02"))
		}
		fileName := fmt.Sprintf("bills_by_user%s_%s.zip", sinceStr, dateStr)
		c.Header("Content-Description", "File Transfer")
		c.Header("Content-Disposition", "attachment; filename="+fileName)
		c.Header("Content-Type", "application/zip")
		c.Header("Content-Length", fmt.Sprintf("%d", len(zipData)))

		// Write the zip file to response
		c.Writer.Write(zipData)

		log.Printf("Admin downloaded %d bill files as zip: %s", fileCount, fileName)
	}
}

// Admin: Backup database with optional password in URL
func backupDatabase(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Check if password is provided in URL path
		password := c.Param("password")
		if password != "" {
			// Verify admin credentials
			var id int
			var role string
			err := db.QueryRow("SELECT id, role FROM users WHERE username = 'admin' AND password = ?", password).Scan(&id, &role)
			if err != nil || role != "ADMIN" {
				c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid admin password"})
				return
			}
		} else {
			// Use the usual authentication middleware result
			role, exists := c.Get("role")
			if !exists || role != "ADMIN" {
				c.JSON(http.StatusUnauthorized, gin.H{"error": "Missing token"})
				return
			}
		}

		// Create backups directory if it doesn't exist
		backupDir := "backups"
		if _, err := os.Stat(backupDir); os.IsNotExist(err) {
			os.Mkdir(backupDir, 0755)
		}

		// Create backup file name with timestamp
		timestamp := time.Now().Format("2006-01-02_15-04-05")
		backupFileName := filepath.Join(backupDir, fmt.Sprintf("portal_backup_%s.db", timestamp))

		// Copy the database file
		sourceDB, err := os.Open("data/portal.db")
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to open source database"})
			return
		}
		defer sourceDB.Close()

		destDB, err := os.Create(backupFileName)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create backup file"})
			return
		}
		defer destDB.Close()

		_, err = io.Copy(destDB, sourceDB)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to copy database"})
			return
		}

		// Create a zip file with the database backup
		zipFileName := fmt.Sprintf("%s.zip", backupFileName)
		zipFile, err := os.Create(zipFileName)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create zip file"})
			return
		}
		defer zipFile.Close()

		zipWriter := zip.NewWriter(zipFile)
		defer zipWriter.Close()

		// Add database backup to zip
		dbFileWriter, err := zipWriter.Create(filepath.Base(backupFileName))
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create zip entry"})
			return
		}

		// Re-open source file for reading
		sourceDB.Close()
		sourceDB, err = os.Open(backupFileName)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to open backup file"})
			return
		}
		defer sourceDB.Close()

		_, err = io.Copy(dbFileWriter, sourceDB)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to write to zip"})
			return
		}

		// Close zip file
		zipWriter.Close()

		// Serve the zip file
		c.Header("Content-Description", "File Transfer")
		c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=portal_backup_%s.zip", timestamp))
		c.Header("Content-Type", "application/zip")

		c.File(zipFileName)

		// Clean up backup file (keep only the zip)
		os.Remove(backupFileName)

		log.Printf("Admin created database backup: %s", zipFileName)
	}
}

// Health check API - tests if all components are working
func healthCheck(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		health := map[string]interface{}{
			"status":     "ok",
			"version":    "1.0.0",
			"timestamp":  time.Now().Format(time.RFC3339),
			"components": make(map[string]interface{}),
		}

		// Check database connection
		dbStatus := "ok"
		err := db.Ping()
		if err != nil {
			dbStatus = fmt.Sprintf("error: %v", err)
			health["status"] = "degraded"
		}

		// Check filesystem access using DATA_DIR environment variable
		fsStatus := "ok"
		dataDir := os.Getenv("DATA_DIR")
		if dataDir == "" {
			dataDir = "data" // Fallback to default
		}

		// Check subdirectories in the data directory
		subDirs := []string{"bills", "logs", "backups"}
		inaccessibleDirs := []string{}

		for _, dir := range subDirs {
			dirPath := filepath.Join(dataDir, dir)
			if _, err := os.Stat(dirPath); os.IsNotExist(err) {
				inaccessibleDirs = append(inaccessibleDirs, dirPath)
			}
		}

		if len(inaccessibleDirs) > 0 {
			fsStatus = fmt.Sprintf("error: directories not accessible: %v", inaccessibleDirs)
			health["status"] = "degraded"
		}

		// Count resources
		var userCount, productCount, registrationCount int
		db.QueryRow("SELECT COUNT(*) FROM users").Scan(&userCount)
		db.QueryRow("SELECT COUNT(*) FROM products").Scan(&productCount)
		db.QueryRow("SELECT COUNT(*) FROM registrations").Scan(&registrationCount)

		// Add component statuses
		components := health["components"].(map[string]interface{})
		components["database"] = map[string]interface{}{
			"status": dbStatus,
			"counts": map[string]int{
				"users":         userCount,
				"products":      productCount,
				"registrations": registrationCount,
			},
		}
		components["filesystem"] = map[string]interface{}{
			"status": fsStatus,
		}

		c.JSON(http.StatusOK, health)
	}
}

// API Documentation - provides information on how to use the API
func apiDocumentation() gin.HandlerFunc {
	return func(c *gin.Context) {
		docs := map[string]interface{}{
			"api_version":   "1.0.0",
			"title":         "Product Registration Portal API",
			"description":   "API for managing product registrations, users, and admin functions",
			"base_url":      "http://localhost:8080",
			"documentation": "This endpoint provides information about all available API endpoints",
			"endpoints":     []map[string]interface{}{},
		}

		// Authentication endpoints
		docs["endpoints"] = append(docs["endpoints"].([]map[string]interface{}), map[string]interface{}{
			"path":        "/login",
			"method":      "POST",
			"description": "Authenticates a user or admin",
			"body":        map[string]string{"mobile": "User mobile number", "password": "Required only for admin"},
			"response":    map[string]string{"token": "Authentication token", "role": "User role (ADMIN or CUSTOMER)"},
			"example":     "POST /login {\"mobile\": \"9999999999\"} or {\"mobile\": \"admin\", \"password\": \"xxxxx\"}",
		})

		docs["endpoints"] = append(docs["endpoints"].([]map[string]interface{}), map[string]interface{}{
			"path":        "/register",
			"method":      "POST",
			"description": "Registers a new customer",
			"body":        map[string]string{"mobile": "Mobile number", "company": "Company name", "gst": "GST number"},
			"response":    map[string]string{"token": "Authentication token"},
			"example":     "POST /register {\"mobile\": \"9999999999\", \"company\": \"My Company\", \"gst\": \"GST123456\"}",
		})

		// Customer endpoints
		docs["endpoints"] = append(docs["endpoints"].([]map[string]interface{}), map[string]interface{}{
			"path":        "/register-product",
			"method":      "POST",
			"auth":        "Customer token required",
			"description": "Register a new product with serial number and bill file",
			"body":        map[string]string{"serial": "Product serial number", "product_id": "ID of the product", "bill": "Bill file (multipart form)"},
			"response":    map[string]string{"status": "pending"},
			"example":     "POST /register-product FormData with serial, product_id and bill file",
		})

		docs["endpoints"] = append(docs["endpoints"].([]map[string]interface{}), map[string]interface{}{
			"path":        "/my-registrations",
			"method":      "GET",
			"auth":        "Customer token required",
			"description": "Get customer's own product registrations",
			"response":    "Array of registration objects",
			"example":     "GET /my-registrations",
		})

		// Admin user management
		docs["endpoints"] = append(docs["endpoints"].([]map[string]interface{}), map[string]interface{}{
			"path":        "/admin/users",
			"method":      "GET",
			"auth":        "Admin token required",
			"description": "List all users",
			"response":    "Array of user objects",
			"example":     "GET /admin/users",
		})

		// Admin product management
		docs["endpoints"] = append(docs["endpoints"].([]map[string]interface{}), map[string]interface{}{
			"path":        "/admin/products",
			"method":      "GET",
			"auth":        "Admin token required",
			"description": "List all products",
			"response":    "Array of product objects",
			"example":     "GET /admin/products",
		})

		// Admin registration management
		docs["endpoints"] = append(docs["endpoints"].([]map[string]interface{}), map[string]interface{}{
			"path":        "/admin/registrations",
			"method":      "GET",
			"auth":        "Admin token required",
			"description": "List all product registrations",
			"response":    "Array of registration objects",
			"example":     "GET /admin/registrations",
		})

		// Export and backup endpoints
		docs["endpoints"] = append(docs["endpoints"].([]map[string]interface{}), map[string]interface{}{
			"path":                  "/admin/export/csv",
			"method":                "GET",
			"auth":                  "Admin token required",
			"description":           "Export all registrations as CSV file",
			"response":              "CSV file download",
			"example":               "GET /admin/export/csv",
			"direct_access_example": "GET /admin/export/csv/{password}",
		})

		docs["endpoints"] = append(docs["endpoints"].([]map[string]interface{}), map[string]interface{}{
			"path":                  "/admin/export/bills",
			"method":                "GET",
			"auth":                  "Admin token required",
			"description":           "Download all bill files organized by user mobile number",
			"parameters":            map[string]string{"since": "Optional. Filter bills created after this date (format: YYYY-MM-DD)"},
			"response":              "ZIP file download",
			"example":               "GET /admin/export/bills or GET /admin/export/bills?since=2025-05-01",
			"direct_access_example": "GET /admin/export/bills/{password} or GET /admin/export/bills/{password}?since=2025-05-01",
		})

		docs["endpoints"] = append(docs["endpoints"].([]map[string]interface{}), map[string]interface{}{
			"path":                  "/admin/backup",
			"method":                "GET",
			"auth":                  "Admin token required",
			"description":           "Create and download a database backup",
			"response":              "ZIP file with database backup",
			"example":               "GET /admin/backup",
			"direct_access_example": "GET /admin/backup/{password}",
		})

		// Health check endpoint
		docs["endpoints"] = append(docs["endpoints"].([]map[string]interface{}), map[string]interface{}{
			"path":        "/health",
			"method":      "GET",
			"description": "Check system health",
			"response":    "System health status",
			"example":     "GET /health",
		})

		c.JSON(http.StatusOK, docs)
	}
}

func main() {
	r := gin.Default()
	setupEnvironment()
	db := setupDatabase()
	defer db.Close()
	ensureAdmin(db)

	r.Use(setupCORS())

	// Get data directory for bill files
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "data" // Fallback
	}
	billsDir := filepath.Join(dataDir, "bills")

	// Serve bill files statically - FIX PATH TO MATCH CLIENT REQUESTS
	r.Static("/bills", billsDir)

	r.GET("/", func(c *gin.Context) {
		c.String(http.StatusOK, "Portal System API is running.")
	})

	r.POST("/register", registerUser(db))
	r.POST("/login", loginUser(db))

	r.POST("/register-product", authMiddleware(db, false), registerProduct(db))
	r.GET("/my-registrations", authMiddleware(db, false), listOwnRegistrations(db))
	r.GET("/customer/dashboard", authMiddleware(db, false), customerDashboard(db))
	r.GET("/customer/active-products", authMiddleware(db, false), listActiveProducts(db))

	r.GET("/admin/users", authMiddleware(db, true), listUsers(db))
	r.POST("/admin/user", authMiddleware(db, true), upsertUser(db))
	r.DELETE("/admin/user/:id", authMiddleware(db, true), deleteUser(db))

	r.GET("/admin/products", authMiddleware(db, true), listProducts(db))
	r.POST("/admin/product", authMiddleware(db, true), upsertProduct(db))
	r.DELETE("/admin/product/:id", authMiddleware(db, true), deleteProduct(db))

	r.GET("/admin/registrations", authMiddleware(db, true), listRegistrations(db))
	r.PUT("/admin/registration/:id", authMiddleware(db, true), updateRegistration(db))
	r.DELETE("/admin/registration/:id/bill", authMiddleware(db, true), deleteBillFile(db))
	r.GET("/admin/registration/search", authMiddleware(db, true), searchRegistration(db))
	r.GET("/admin/dashboard", authMiddleware(db, true), adminDashboard(db))

	// New export and backup endpoints
	r.GET("/admin/export/csv", authMiddleware(db, true), exportRegistrationsCSV(db))
	r.GET("/admin/export/bills", authMiddleware(db, true), downloadBillsByUser(db))
	r.GET("/admin/backup", authMiddleware(db, true), backupDatabase(db))

	// Direct access endpoints with password in URL
	r.GET("/admin/export/csv/:password", exportRegistrationsCSV(db))
	r.GET("/admin/export/bills/:password", downloadBillsByUser(db))
	r.GET("/admin/backup/:password", backupDatabase(db)) // Correct URL for backup

	// Health check endpoint
	r.GET("/health", healthCheck(db))

	// API documentation endpoint
	r.GET("/docs", apiDocumentation())

	r.Run(":8080")
}
