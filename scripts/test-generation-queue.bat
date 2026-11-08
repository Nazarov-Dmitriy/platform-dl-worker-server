@echo off
REM ============================================================
REM  Local test: generation queue (task-queue feature)
REM  Prerequisites:
REM    1. Dispatcher running on http://127.0.0.1:8090
REM    2. Processor connected with a generation model
REM    3. A site with media.generate operation enabled
REM
REM  Usage:
REM    1. Create a site and device (once):
REM       dispatcher.exe site-create --name test-site
REM       dispatcher.exe device-create --site test-site
REM    2. Copy the device token and site token below
REM    3. Start the processor with a generation model
REM    4. Run this script
REM ============================================================

set DISPATCHER=http://127.0.0.1:8090
set SITE_TOKEN=
set DEVICE_TOKEN=

if "%SITE_TOKEN%"=="" (
    echo ERROR: Set SITE_TOKEN environment variable
    exit /b 1
)
if "%DEVICE_TOKEN%"=="" (
    echo ERROR: Set DEVICE_TOKEN environment variable
    exit /b 1
)

echo ============================================================
echo  Test: Generation Queue
echo ============================================================
echo.

REM --- Step 1: Submit first generation job (will start immediately) ---
echo [1/6] Submit first generation job (should start immediately)...
set /p JOB1_ID=<nul
for /f "delims=" %%i in ('curl -s -X POST "%DISPATCHER%/api/v2/site/jobs" ^
  -H "Authorization: Bearer %SITE_TOKEN%" ^
  -H "Content-Type: application/json" ^
  -d "{\"id\":\"%RANDOM%\",\"type\":\"media.generate\",\"params\":{\"modelId\":\"flux2-klein-4b-q4\",\"modelRevision\":\"abc123\",\"profileRevision\":\"abc123\",\"inputs\":{\"prompt\":\"test image 1\",\"width\":512,\"height\":512,\"seed\":42}},\"source\":{}}'") do set JOB1_RESPONSE=%%i
echo Response: %JOB1_RESPONSE%
echo.

REM Extract job1 ID from response (assuming format {"id":"...","status":"QUEUED",...})
for /f "delims=" %%i in ('curl -s -X POST "%DISPATCHER%/api/v2/site/jobs" ^
  -H "Authorization: Bearer %SITE_TOKEN%" ^
  -H "Content-Type: application/json" ^
  -d "{\"id\":\"job-queue-test-1\",\"type\":\"media.generate\",\"params\":{\"modelId\":\"flux2-klein-4b-q4\",\"modelRevision\":\"abc123\",\"profileRevision\":\"abc123\",\"inputs\":{\"prompt\":\"test image 1\",\"width\":512,\"height\":512,\"seed\":42}},\"source\":{}}'") do set JOB1_RESPONSE=%%i
echo [1/6] Submit first generation job (will occupy the model)...
curl -s -X POST "%DISPATCHER%/api/v2/site/jobs" ^
  -H "Authorization: Bearer %SITE_TOKEN%" ^
  -H "Content-Type: application/json" ^
  -d "{\"id\":\"job-queue-test-1\",\"type\":\"media.generate\",\"params\":{\"modelId\":\"flux2-klein-4b-q4\",\"modelRevision\":\"abc123\",\"profileRevision\":\"abc123\",\"inputs\":{\"prompt\":\"test image 1\",\"width\":512,\"height\":512,\"seed\":42}},\"source\":{}}" | python -m json.tool 2>nul || curl -s -X POST "%DISPATCHER%/api/v2/site/jobs" ^
  -H "Authorization: Bearer %SITE_TOKEN%" ^
  -H "Content-Type: application/json" ^
  -d "{\"id\":\"job-queue-test-1\",\"type\":\"media.generate\",\"params\":{\"modelId\":\"flux2-klein-4b-q4\",\"modelRevision\":\"abc123\",\"profileRevision\":\"abc123\",\"inputs\":{\"prompt\":\"test image 1\",\"width\":512,\"height\":512,\"seed\":42}},\"source\":{}}"
echo.
timeout /t 2 /nobreak >nul

REM --- Step 2: Submit second generation job (should queue) ---
echo [2/6] Submit second generation job (should go to queue)...
curl -s -X POST "%DISPATCHER%/api/v2/site/jobs" ^
  -H "Authorization: Bearer %SITE_TOKEN%" ^
  -H "Content-Type: application/json" ^
  -d "{\"id\":\"job-queue-test-2\",\"type\":\"media.generate\",\"params\":{\"modelId\":\"flux2-klein-4b-q4\",\"modelRevision\":\"abc123\",\"profileRevision\":\"abc123\",\"inputs\":{\"prompt\":\"test image 2\",\"width\":512,\"height\":512,\"seed\":43}},\"source\":{}}" | python -m json.tool 2>nul || curl -s -X POST "%DISPATCHER%/api/v2/site/jobs" ^
  -H "Authorization: Bearer %SITE_TOKEN%" ^
  -H "Content-Type: application/json" ^
  -d "{\"id\":\"job-queue-test-2\",\"type\":\"media.generate\",\"params\":{\"modelId\":\"flux2-klein-4b-q4\",\"modelRevision\":\"abc123\",\"profileRevision\":\"abc123\",\"inputs\":{\"prompt\":\"test image 2\",\"width\":512,\"height\":512,\"seed\":43}},\"source\":{}}"
echo.
timeout /t 3 /nobreak >nul

REM --- Step 3: Check job-queue-test-2 status (stays QUEUED while the device is busy) ---
echo [3/6] Check second job status (expected: QUEUED)...
curl -s "%DISPATCHER%/api/v2/site/jobs/job-queue-test-2" ^
  -H "Authorization: Bearer %SITE_TOKEN%" | python -m json.tool 2>nul || curl -s "%DISPATCHER%/api/v2/site/jobs/job-queue-test-2" ^
  -H "Authorization: Bearer %SITE_TOKEN%"
echo.

REM --- Step 4: Check model availability (should still show model even though busy) ---
echo [4/6] Check generation models (model should be visible even when busy)...
curl -s "%DISPATCHER%/api/v2/site/generation/models" ^
  -H "Authorization: Bearer %SITE_TOKEN%" | python -m json.tool 2>nul || curl -s "%DISPATCHER%/api/v2/site/generation/models" ^
  -H "Authorization: Bearer %SITE_TOKEN%"
echo.

REM --- Step 5: Wait for first job to complete and verify second starts ---
echo [5/6] Waiting for first job to complete, then second should start automatically...
echo Monitoring job-queue-test-1 status...
:wait_job1
timeout /t 3 /nobreak >nul
curl -s "%DISPATCHER%/api/v2/site/jobs/job-queue-test-1" -H "Authorization: Bearer %SITE_TOKEN%" > %TEMP%\job1_status.json 2>nul
find /i "\"status\":\"SUCCEEDED\"" %TEMP%\job1_status.json >nul 2>&1
if errorlevel 1 (
    echo ... still running
    goto :wait_job1
)
echo Job 1 completed! Checking job 2...
timeout /t 5 /nobreak >nul
curl -s "%DISPATCHER%/api/v2/site/jobs/job-queue-test-2" ^
  -H "Authorization: Bearer %SITE_TOKEN%" | python -m json.tool 2>nul || curl -s "%DISPATCHER%/api/v2/site/jobs/job-queue-test-2" ^
  -H "Authorization: Bearer %SITE_TOKEN%"
echo.

REM --- Step 6: Test cancel of a queued job ---
echo [6/6] Submit third job, then cancel it while queued...
curl -s -X POST "%DISPATCHER%/api/v2/site/jobs" ^
  -H "Authorization: Bearer %SITE_TOKEN%" ^
  -H "Content-Type: application/json" ^
  -d "{\"id\":\"job-queue-test-3\",\"type\":\"media.generate\",\"params\":{\"modelId\":\"flux2-klein-4b-q4\",\"modelRevision\":\"abc123\",\"profileRevision\":\"abc123\",\"inputs\":{\"prompt\":\"test image 3\",\"width\":512,\"height\":512,\"seed\":44}},\"source\":{}}" >nul 2>nul
timeout /t 2 /nobreak >nul
echo Cancelling job-queue-test-3...
curl -s -X POST "%DISPATCHER%/api/v2/site/jobs/job-queue-test-3/cancel" ^
  -H "Authorization: Bearer %SITE_TOKEN%" ^
  -H "Content-Type: application/json" ^
  -d "{\"requestId\":\"cancel-1\"}" | python -m json.tool 2>nul || curl -s -X POST "%DISPATCHER%/api/v2/site/jobs/job-queue-test-3/cancel" ^
  -H "Authorization: Bearer %SITE_TOKEN%" ^
  -H "Content-Type: application/json" ^
  -d "{\"requestId\":\"cancel-1\"}"
echo.

echo.
echo ============================================================
echo  Test complete. Check the outputs above.
echo ============================================================
