; Inno Setup 6 — builds a single-file Windows installer.
; Install: https://jrsoftware.org/isdl.php
; Build: .\build_installer.ps1  (or compile this .iss from Inno Setup GUI)

#define MyAppName "MT5 Remote Agent"
#define MyAppVersion "0.2.0"
#define DistRel "dist\MT5RemoteAgent"

[Setup]
AppId={{B5E8F2A1-3C4D-5E6F-A7B8-C9D0E1F2A3B4}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=MT5 Panel
DefaultDirName={commonpf64}\{#MyAppName}
DisableProgramGroupPage=yes
OutputDir=installer_output
OutputBaseFilename=MT5RemoteAgent-Setup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#DistRel}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\MT5RemoteAgent.exe"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\MT5RemoteAgent.exe"; Tasks: desktopicon
