# Run Full Indexer - All Databases
# US-P8-006: Re-index all 20K documents with full content
#
# USAGE:
#   .\run-full-indexer.ps1 -Database decisive_appraiser   # Index ~10,000 decisions
#   .\run-full-indexer.ps1 -Database appeals_committee    # Index ~5,000 decisions
#   .\run-full-indexer.ps1 -Database appeals_board        # Index ~5,000 decisions
#   .\run-full-indexer.ps1 -Resume                        # Resume from last saved progress
#   .\run-full-indexer.ps1 -Restart -Database decisive_appraiser  # Force restart
#
# NOTES:
#   - Each database takes hours to complete due to rate limiting (1 req/sec)
#   - Progress is saved automatically for resume capability
#   - Monitor progress in n8n UI: https://a-i-do.app.n8n.cloud/workflow/1zYlIK6VnynTHiHl
#   - ScraperAPI cost estimate: ~$100 for all 20K documents

param(
    [Parameter()]
    [ValidateSet('decisive_appraiser', 'appeals_committee', 'appeals_board')]
    [string]$Database = 'decisive_appraiser',

    [Parameter()]
    [switch]$Resume,

    [Parameter()]
    [switch]$Restart
)

$webhookUrl = "https://a-i-do.app.n8n.cloud/webhook/full-indexer"

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  Full Indexer - Gov.il Decisions" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

# Build request body
$body = @{}

if ($Resume) {
    $body.resume = $true
    Write-Host "Mode: RESUME from last saved progress" -ForegroundColor Yellow
} elseif ($Restart) {
    $body.restart = $true
    $body.database = $Database
    Write-Host "Mode: RESTART (force) - Database: $Database" -ForegroundColor Red
} else {
    $body.database = $Database
    Write-Host "Mode: START - Database: $Database" -ForegroundColor Green
}

Write-Host ""
Write-Host "Webhook URL: $webhookUrl" -ForegroundColor Gray
Write-Host "Request Body: $($body | ConvertTo-Json -Compress)" -ForegroundColor Gray
Write-Host ""

# Database info
$dbInfo = @{
    'decisive_appraiser' = @{ name = "שמאי מכריע"; count = "~10,000" }
    'appeals_committee'  = @{ name = "ועדת השגות"; count = "~5,000" }
    'appeals_board'      = @{ name = "ועדת ערעורים"; count = "~5,000" }
}

if (-not $Resume) {
    $info = $dbInfo[$Database]
    Write-Host "Database: $($info.name)" -ForegroundColor Cyan
    Write-Host "Estimated documents: $($info.count)" -ForegroundColor Cyan
    Write-Host ""
}

Write-Host "Starting indexer..." -ForegroundColor Yellow
Write-Host "(This triggers the workflow - monitor progress in n8n UI)" -ForegroundColor Gray
Write-Host ""

try {
    $jsonBody = $body | ConvertTo-Json
    $response = Invoke-RestMethod -Uri $webhookUrl -Method POST -Body $jsonBody -ContentType "application/json" -TimeoutSec 30

    Write-Host "Response:" -ForegroundColor Green
    $response | ConvertTo-Json -Depth 10

    Write-Host ""
    Write-Host "======================================" -ForegroundColor Cyan
    Write-Host "Indexer triggered successfully!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Yellow
    Write-Host "1. Monitor progress at: https://a-i-do.app.n8n.cloud/workflow/1zYlIK6VnynTHiHl" -ForegroundColor White
    Write-Host "2. Check executions at: https://a-i-do.app.n8n.cloud/executions" -ForegroundColor White
    Write-Host "3. If interrupted, run: .\run-full-indexer.ps1 -Resume" -ForegroundColor White
    Write-Host "======================================" -ForegroundColor Cyan
}
catch {
    Write-Host "Error triggering indexer:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red

    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $responseBody = $reader.ReadToEnd()
        Write-Host "Response: $responseBody" -ForegroundColor Red
    }

    exit 1
}
