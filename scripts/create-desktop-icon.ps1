$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$iconDirectory = Join-Path $PSScriptRoot '..\desktop\resources'
New-Item -ItemType Directory -Path $iconDirectory -Force | Out-Null
function Draw-RoundedRectangle($Canvas, $Brush, $X, $Y, $Width, $Height, $Radius) {
    $shape = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $diameter = $Radius * 2
    $shape.AddArc($X, $Y, $diameter, $diameter, 180, 90)
    $shape.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
    $shape.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
    $shape.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
    $shape.CloseFigure()
    $Canvas.FillPath($Brush, $shape)
    $shape.Dispose()
}
$bitmap = [System.Drawing.Bitmap]::new(256, 256)
$canvas = [System.Drawing.Graphics]::FromImage($bitmap)
$canvas.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$green = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#214e43'))
$sage = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#a8c5a0'))
$paper = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#faf9f5'))
Draw-RoundedRectangle $canvas $green 5 5 246 246 61
$savedTransform = $canvas.Save()
$canvas.TranslateTransform(128, 128)
$canvas.RotateTransform(-12)
Draw-RoundedRectangle $canvas $sage -66 -73 109 142 17
$canvas.Restore($savedTransform)
Draw-RoundedRectangle $canvas $paper 96 68 104 140 18
$pen = [System.Drawing.Pen]::new($green, 12)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$canvas.DrawLines($pen, [System.Drawing.Point[]]@([System.Drawing.Point]::new(124,140), [System.Drawing.Point]::new(141,157), [System.Drawing.Point]::new(173,117)))
$bitmap.Save((Join-Path $iconDirectory 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$chunks = @()
foreach ($size in @(16,24,32,48,64,128,256)) {
    $resized = [System.Drawing.Bitmap]::new($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($resized)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($bitmap, 0, 0, $size, $size)
    $stream = [System.IO.MemoryStream]::new()
    $resized.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $chunks += ,@{ Size = $size; Data = $stream.ToArray() }
    $stream.Dispose(); $g.Dispose(); $resized.Dispose()
}
$iconFile = [System.IO.File]::Create((Join-Path $iconDirectory 'icon.ico'))
$writer = [System.IO.BinaryWriter]::new($iconFile)
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$chunks.Count)
$offset = 6 + 16 * $chunks.Count
foreach ($chunk in $chunks) {
    $dimension = if ($chunk.Size -eq 256) { 0 } else { $chunk.Size }
    $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
    $writer.Write([byte]0); $writer.Write([byte]0)
    $writer.Write([uint16]1); $writer.Write([uint16]32)
    $writer.Write([uint32]$chunk.Data.Length); $writer.Write([uint32]$offset)
    $offset += $chunk.Data.Length
}
foreach ($chunk in $chunks) { $writer.Write([byte[]]$chunk.Data) }
$writer.Dispose(); $canvas.Dispose(); $bitmap.Dispose(); $pen.Dispose(); $green.Dispose(); $sage.Dispose(); $paper.Dispose()
Write-Output 'Created desktop/resources/icon.ico'
