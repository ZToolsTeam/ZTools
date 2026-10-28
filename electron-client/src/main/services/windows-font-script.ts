/** 固定 WPF 程序；请求只从标准输入解析，字体标识和预览文字不会拼入 PowerShell 源码。 */
export const WINDOWS_FONT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName PresentationCore,WindowsBase,PresentationFramework
function NameValue($names) {
  if ($null -eq $names -or $names.Count -eq 0) { return '' }
  $culture = [System.Globalization.CultureInfo]::GetCultureInfo('en-US')
  if ($names.ContainsKey($culture)) { return [string]$names[$culture] }
  return [string](@($names.Values)[0])
}
try {
  $inputValue = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($inputValue.operation -ne 'fonts-list' -and $inputValue.operation -ne 'fonts-preview') { throw 'INVALID_REQUEST' }
  $items = New-Object 'System.Collections.Generic.List[object]'
  $seen = New-Object 'System.Collections.Generic.HashSet[string]'
  $selected = $null; $selectedGlyph = $null
  foreach ($face in [System.Windows.Media.Fonts]::SystemTypefaces) {
    $glyph = $null
    if (!$face.TryGetGlyphTypeface([ref]$glyph) -or !$glyph.FontUri.IsFile) { continue }
    $id = $glyph.FontUri.AbsoluteUri + '|' + $face.Style + '|' + $face.Weight + '|' + $face.Stretch
    if (!$seen.Add($id)) { continue }
    if ($items.Count -ge 10000) { throw 'TOO_MANY_FONTS' }
    $license = NameValue $glyph.LicenseDescriptions
    $items.Add(@{ id=$id; family=(NameValue $glyph.FamilyNames); style=(NameValue $glyph.FaceNames); filePath=$glyph.FontUri.LocalPath;
      hasLicense=($license.Length -gt 0); system=$glyph.FontUri.LocalPath.StartsWith(([Environment]::GetFolderPath('Fonts') + '\'), [StringComparison]::OrdinalIgnoreCase) })
    if ($id -ceq $inputValue.id) { $selected=$face; $selectedGlyph=$glyph }
  }
  if ($inputValue.operation -eq 'fonts-list') { $result=@{ version=1; success=$true; fonts=@($items.ToArray()) } }
  else {
    if ($null -eq $selected) { throw 'FONT_UNAVAILABLE' }
    $text=[string]$inputValue.text
    if (!$text.Trim() -or $text.Length -gt 320) { throw 'INVALID_REQUEST' }
    $formatted = New-Object System.Windows.Media.FormattedText($text, [System.Globalization.CultureInfo]::CurrentCulture, [System.Windows.FlowDirection]::LeftToRight, $selected, 48.0, [System.Windows.Media.Brushes]::Black, 1.0)
    $formatted.MaxTextWidth=936
    if ($formatted.Height -gt 1500) { throw 'PREVIEW_TOO_LONG' }
    $height=[int][Math]::Ceiling([Math]::Max(128, $formatted.Height+80))
    $visual=New-Object System.Windows.Media.DrawingVisual
    $context=$visual.RenderOpen()
    try {
      $context.DrawRectangle([System.Windows.Media.Brushes]::White, $null, (New-Object System.Windows.Rect(0,0,1000,$height)))
      $context.DrawText($formatted, (New-Object System.Windows.Point(32,32)))
    } finally { $context.Close() }
    $bitmap=New-Object System.Windows.Media.Imaging.RenderTargetBitmap(1000,$height,96,96,[System.Windows.Media.PixelFormats]::Pbgra32)
    $bitmap.Render($visual)
    $encoder=New-Object System.Windows.Media.Imaging.PngBitmapEncoder
    $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
    $stream=New-Object System.IO.MemoryStream
    try { $encoder.Save($stream); $png=[Convert]::ToBase64String($stream.ToArray()) } finally { $stream.Dispose() }
    $coverageWarning=''
    for ($i=0; $i -lt $text.Length; $i++) {
      if ([Char]::IsWhiteSpace($text[$i])) { continue }
      $code=[Char]::ConvertToUtf32($text,$i)
      if ([Char]::IsHighSurrogate($text[$i])) { $i++ }
      if (!$selectedGlyph.CharacterToGlyphMap.ContainsKey($code)) { $coverageWarning='所选字体缺少部分字符，预览可能显示替代字形或缺字符号'; break }
    }
    $result=@{ version=1; success=$true; id=$inputValue.id; png=$png; fallbacks=@(); coverageWarning=$coverageWarning;
      license=(NameValue $selectedGlyph.LicenseDescriptions); licenseUrl=''; copyright=(NameValue $selectedGlyph.Copyrights); manufacturer=(NameValue $selectedGlyph.ManufacturerNames) }
  }
  [Console]::Write(($result | ConvertTo-Json -Depth 6 -Compress))
} catch {
  [Console]::Write((@{ version=1; success=$false; code='FONT_OPERATION_FAILED' } | ConvertTo-Json -Compress)); exit 1
}
`
