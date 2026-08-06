#ifndef SYSTEM_COMMANDS_H
#define SYSTEM_COMMANDS_H

#include <Arduino.h>

enum SysCommand {
    CMD_NONE = 0,
    CMD_START_SESSION,
    CMD_STOP_SESSION,
    CMD_RECALIBRATE
};

struct SysCommandMsg {
    SysCommand cmd;
    char patientId[32]; // Max 31 characters + null terminator
};

// Global queue handle for sending system commands from WebServer to main loop
extern QueueHandle_t sysCommandQueue;

#endif // SYSTEM_COMMANDS_H
