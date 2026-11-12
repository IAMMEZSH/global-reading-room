Option Explicit
' Global Reading Room launcher: starts the bundled Node.js runtime hidden.
' The server opens the default browser and keeps running in the background.
Dim fso, shell, base, nodePath, serverPath, command
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

base = fso.GetParentFolderName(WScript.ScriptFullName)
nodePath = base & "\runtime\node.exe"
serverPath = base & "\server.js"

If Not fso.FileExists(serverPath) Then
  MsgBox "server.js was not found next to this launcher." & vbCrLf & _
         "Extract the complete ZIP and try again.", 16, "Global Reading Room"
  WScript.Quit 1
End If

If Not fso.FileExists(nodePath) Then
  nodePath = "node.exe"
End If

shell.CurrentDirectory = base
command = """" & nodePath & """ """ & serverPath & """"
On Error Resume Next
shell.Run command, 0, False
If Err.Number <> 0 Then
  MsgBox "Could not start the local server." & vbCrLf & _
         "Open a console and run Start Global Reading Room (console).cmd to see the error.", 16, "Global Reading Room"
  WScript.Quit 1
End If
On Error GoTo 0
