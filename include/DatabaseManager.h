#ifndef DATABASE_MANAGER_H
#define DATABASE_MANAGER_H

#include <Arduino.h>
#include <sqlite3.h>
#include <LittleFS.h>
#include "Config.h"
#include "AnalyticsEngine.h" // For SessionRecord

class DatabaseManager {
public:
    DatabaseManager();
    ~DatabaseManager();

    // Initialize SQLite
    bool init(bool useSD);

    // Create a new session record in the database
    bool saveSession(const SessionRecord& rec);

    // Retrieve sessions as JSON string (paginated)
    String getSessionsJson(int limit = 50, int offset = 0);

    // Check if SD is currently being used
    bool isSDAvailable() const { return usingSD; }

    // Close database gracefully
    void close();

private:
    sqlite3* db;
    bool usingSD;
    const char* dbPathSD;
    const char* dbPathFS;

    // Helper to execute a query without results
    bool execQuery(const char* sql);
    
    // Attempt to merge from FS to SD if needed
    bool mergeAndCleanupLittleFS();
    
    // Ensure table exists
    bool createTables();
};

extern DatabaseManager dbManager;

#endif // DATABASE_MANAGER_H
