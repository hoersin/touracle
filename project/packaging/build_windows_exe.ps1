Param(
    [string]$Name = "Touracle"
)

$ErrorActionPreference = "Stop"

Write-Host "[Touracle] Installing dependencies..."
python -m pip install --upgrade pip
pip install -r project/requirements.txt
pip install pyinstaller

Write-Host "[Touracle] Building Windows executable (onedir)..."
$dist = "releases/windows"
pyinstaller --noconfirm --clean --onedir --name "$Name" --distpath "$dist" `
  --add-data "project/frontend;project/frontend" `
  --add-data "project/data/milano_to_rome_demo.gpx;project/data" `
  --add-data "project/cache/offline_weather_2025.sqlite;project/cache" `
  project/backend/app.py

Write-Host "[Touracle] Done. Output in $dist/$Name/"
