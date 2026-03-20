#!/bin/bash

# Manual Test Script for Conductor Daemon
#
# Prerequisites:
# 1. Backend running (make start-backend)
# 2. Daemon running (make start-deamon)
#
# Usage: ./scripts/test-daemon-manual.sh

set -e

BACKEND_URL="http://localhost:6152"
PROJECT_NAME="test-project-$(date +%s)"
TASK_TITLE="test-task-$(date +%s)"

echo "Creating project '$PROJECT_NAME'..."
PROJECT_RES=$(curl -s -X POST "$BACKEND_URL/projects" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"$PROJECT_NAME\"}")

PROJECT_ID=$(echo $PROJECT_RES | grep -o '"id":"[^"]*"' | cut -d'"' -f4)

if [ -z "$PROJECT_ID" ]; then
  echo "Failed to create project. Response: $PROJECT_RES"
  exit 1
fi

echo "Project created with ID: $PROJECT_ID"

echo "Creating task '$TASK_TITLE'..."
TASK_RES=$(curl -s -X POST "$BACKEND_URL/tasks" \
  -H "Content-Type: application/json" \
  -d "{\"projectId\": \"$PROJECT_ID\", \"title\": \"$TASK_TITLE\", \"backendType\": \"copilot\", \"initialContent\": \"hello from test script\"}")

TASK_ID=$(echo $TASK_RES | grep -o '"id":"[^"]*"' | cut -d'"' -f4)

if [ -z "$TASK_ID" ]; then
  echo "Failed to create task. Response: $TASK_RES"
  exit 1
fi

echo "Task created with ID: $TASK_ID"
echo ""
echo "Check the daemon logs. You should see:"
echo "1. 'Creating task $TASK_ID for project $PROJECT_ID'"
echo "2. 'Spawning CLI in ...'"
echo ""
echo "Check the workspace directory (default ~/ws or configured in ~/.conductor/config.yaml):"
echo "ls -R <WORKSPACE_ROOT>/$PROJECT_ID/$TASK_ID"
