; Inno Setup script for Strata — Windows installer
; Download Inno Setup: https://jrsoftware.org/isdl.php
;
; Run from the repo root after PyInstaller build:
;   iscc desktop\build\installer.iss

#define AppName      "Strata"
#define AppVersion   "1.0.0"
#define AppPublisher "Strata"
#define AppExeName   "Strata.exe"
#define DistDir      "..\..\dist\Strata"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL=https://github.com/Phazertron/Strata
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
AllowNoIcons=yes
OutputDir=..\..\dist\installer
OutputBaseFilename=Strata-Setup-{#AppVersion}
SetupIconFile=..\assets\icon.ico
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest       ; no admin required — installs per-user
ArchitecturesInstallIn64BitMode=x64

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "startup";    Description: "Launch {#AppName} when Windows starts"; GroupDescription: "Startup:"; Flags: unchecked
Name: "desktopicon"; Description: "Create a &desktop shortcut";           GroupDescription: "Additional icons:"; Flags: unchecked

[Files]
Source: "{#DistDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}";                    Filename: "{app}\{#AppExeName}"
Name: "{group}\Uninstall {#AppName}";          Filename: "{uninstallexe}"
Name: "{commondesktop}\{#AppName}";            Filename: "{app}\{#AppExeName}"; Tasks: desktopicon
Name: "{userstartup}\{#AppName}";              Filename: "{app}\{#AppExeName}"; Tasks: startup

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Launch {#AppName} now"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Leave user data intact on uninstall — tracks and presets are in %APPDATA%\Strata
Type: filesandordirs; Name: "{app}"
