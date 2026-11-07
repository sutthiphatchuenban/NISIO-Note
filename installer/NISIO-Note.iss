#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef ProjectRoot
  #error ProjectRoot must be supplied by scripts/build-installer.ts
#endif
#ifndef RuntimeInstaller
  #error RuntimeInstaller must point to the WebView2 standalone installer
#endif
#ifdef TestInstall
  #define ProductId "{F0BBE442-CC20-4983-BE92-29F6020AEAA7}.Test"
  #define ProductName "NISIO Note (Installer Test)"
  #define OutputName "NISIO-Note-Setup-Test-" + AppVersion + "-x64"
  #define AppExe "NISIO Note Test.exe"
  #define ProgId "NISIO.Note.Test"
#else
  #define ProductId "{F0BBE442-CC20-4983-BE92-29F6020AEAA7}"
  #define ProductName "NISIO Note"
  #define OutputName "NISIO-Note-Setup-" + AppVersion + "-x64"
  #define AppExe "NISIO Note.exe"
  #define ProgId "NISIO.Note"
#endif

[Setup]
AppId={{#ProductId}
AppName={#ProductName}
AppVersion={#AppVersion}
AppPublisher=NISIO
VersionInfoVersion={#AppVersion}.0
DefaultDirName={autopf}\{#ProductName}
DefaultGroupName={#ProductName}
DisableDirPage=no
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
WizardStyle=modern
SetupIconFile={#ProjectRoot}\assets\icon.ico
UninstallDisplayIcon={app}\{#AppExe}
OutputDir={#ProjectRoot}\dist
OutputBaseFilename={#OutputName}
Compression=lzma2/normal
SolidCompression=yes
CloseApplications=yes
RestartApplications=no
SetupLogging=yes
Uninstallable=yes
ChangesAssociations=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked

[Files]
Source: "{#ProjectRoot}\dist\NISIO Note.exe"; DestDir: "{app}"; DestName: "{#AppExe}"; Flags: ignoreversion
Source: "{#ProjectRoot}\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#RuntimeInstaller}"; DestName: "MicrosoftEdgeWebView2RuntimeInstallerX64.exe"; Flags: dontcopy

[Icons]
Name: "{autoprograms}\{#ProductName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"
Name: "{autodesktop}\{#ProductName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
; Register as an Open with candidate only; never change the user's default app.
Root: HKA; Subkey: "Software\Classes\Applications\{#AppExe}"; ValueType: string; ValueName: "FriendlyAppName"; ValueData: "{#ProductName}"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\Applications\{#AppExe}\DefaultIcon"; ValueType: string; ValueData: "{app}\{#AppExe},0"
Root: HKA; Subkey: "Software\Classes\Applications\{#AppExe}\shell\open\command"; ValueType: string; ValueData: """{app}\{#AppExe}"" --open-file ""%1"""
Root: HKA; Subkey: "Software\Classes\{#ProgId}"; ValueType: string; ValueData: "{#ProductName} document"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\{#ProgId}\DefaultIcon"; ValueType: string; ValueData: "{app}\{#AppExe},0"
Root: HKA; Subkey: "Software\Classes\{#ProgId}\shell\open\command"; ValueType: string; ValueData: """{app}\{#AppExe}"" --open-file ""%1"""
#define AddExtension(Ext) \
  'Root: HKA; Subkey: "Software\Classes\Applications\' + AppExe + '\SupportedTypes"; ValueType: string; ValueName: "' + Ext + '"; ValueData: ""' + NewLine + \
  'Root: HKA; Subkey: "Software\Classes\' + Ext + '\OpenWithProgids"; ValueType: string; ValueName: "' + ProgId + '"; ValueData: ""; Flags: uninsdeletevalue'
#emit AddExtension(".txt")
#emit AddExtension(".md")
#emit AddExtension(".markdown")
#emit AddExtension(".log")
#emit AddExtension(".json")
#emit AddExtension(".csv")
#emit AddExtension(".ini")
#emit AddExtension(".yaml")
#emit AddExtension(".yml")

[Run]
Filename: "{app}\{#AppExe}"; Description: "Launch {#ProductName}"; Flags: nowait postinstall skipifsilent; Check: CanLaunch

[Code]
const
  WebViewKey = 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
var
  RuntimeRestartRequired: Boolean;

function RuntimeVersionPresent(RootKey: Integer): Boolean;
var
  Version: String;
begin
  Result := RegQueryStringValue(RootKey, WebViewKey, 'pv', Version) and
    (Version <> '') and (Version <> '0.0.0.0');
end;

function HasWebView2: Boolean;
begin
  Result := RuntimeVersionPresent(HKLM32) or RuntimeVersionPresent(HKLM64) or
    RuntimeVersionPresent(HKCU32) or RuntimeVersionPresent(HKCU64);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExitCode: Integer;
  Installer: String;
begin
  Result := '';
  if HasWebView2 then begin
    Log('WebView2 Runtime is already installed.');
    Exit;
  end;
  WizardForm.PreparingLabel.Caption := 'Installing Microsoft Edge WebView2 Runtime...';
  ExtractTemporaryFile('MicrosoftEdgeWebView2RuntimeInstallerX64.exe');
  Installer := ExpandConstant('{tmp}\MicrosoftEdgeWebView2RuntimeInstallerX64.exe');
  if not Exec(Installer, '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) then begin
    Result := 'Could not start the WebView2 Runtime installer. Please run Setup again.';
    Exit;
  end;
  Log(Format('WebView2 installer exit code: %d', [ExitCode]));
  if ((ExitCode <> 0) and (ExitCode <> 3010)) or not HasWebView2 then begin
    Result := Format('WebView2 Runtime could not be installed (code %d). Restart Windows and run Setup again.', [ExitCode]);
    Exit;
  end;
  RuntimeRestartRequired := ExitCode = 3010;
  NeedsRestart := RuntimeRestartRequired;
end;

function CanLaunch: Boolean;
begin
  Result := HasWebView2 and not RuntimeRestartRequired;
end;

// Uninstall removes installed application files and shortcuts only. User notes,
// attachments, settings, and the shared WebView2 Runtime remain on the machine.
