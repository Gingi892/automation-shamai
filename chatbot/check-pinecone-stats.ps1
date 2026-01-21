# Check Pinecone Index Stats
# US-P8-006: Verify indexing progress

$pineconeHost = "https://gov-il-decisions-k1iqa9s.svc.aped-4627-b74a.pinecone.io"
$pineconeApiKey = $env:PINECONE_API_KEY

if (-not $pineconeApiKey) {
    Write-Host "Error: PINECONE_API_KEY environment variable not set" -ForegroundColor Red
    Write-Host "Set it with: `$env:PINECONE_API_KEY = 'your-api-key'" -ForegroundColor Yellow
    exit 1
}

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  Pinecone Index Stats" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

$headers = @{
    "Api-Key" = $pineconeApiKey
    "Content-Type" = "application/json"
}

try {
    # Get index stats
    $statsUrl = "$pineconeHost/describe_index_stats"
    $response = Invoke-RestMethod -Uri $statsUrl -Method POST -Headers $headers -Body "{}"

    Write-Host "Namespace: gov-il-decisions" -ForegroundColor Yellow
    Write-Host ""

    $totalVectors = $response.totalVectorCount
    Write-Host "Total Vectors: $totalVectors" -ForegroundColor Green
    Write-Host "Dimension: $($response.dimension)" -ForegroundColor Gray
    Write-Host "Index Fullness: $($response.indexFullness)" -ForegroundColor Gray
    Write-Host ""

    # Calculate coverage
    $targetTotal = 20000
    $coverage = [math]::Round(($totalVectors / $targetTotal) * 100, 2)

    Write-Host "Coverage Analysis:" -ForegroundColor Cyan
    Write-Host "  Target: ~$targetTotal documents" -ForegroundColor White
    Write-Host "  Indexed: $totalVectors vectors" -ForegroundColor White
    Write-Host "  Coverage: $coverage%" -ForegroundColor $(if ($coverage -ge 80) { "Green" } elseif ($coverage -ge 50) { "Yellow" } else { "Red" })
    Write-Host ""

    # Check namespace details if available
    if ($response.namespaces) {
        Write-Host "Namespaces:" -ForegroundColor Cyan
        $response.namespaces | ConvertTo-Json -Depth 5
    }

    Write-Host "======================================" -ForegroundColor Cyan
}
catch {
    Write-Host "Error querying Pinecone:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
