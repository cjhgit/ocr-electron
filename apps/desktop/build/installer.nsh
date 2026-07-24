; 安装时若缺少 VC++ 运行库，静默安装（onnxruntime-node 在 Windows 上依赖它）
; 将 vc_redist.x64.exe 放在 build/ 目录后重新打包即可生效；未放置时跳过。
!macro customInstall
  IfFileExists "${BUILD_RESOURCES_DIR}\vc_redist.x64.exe" 0 skip_vc_redist
    DetailPrint "Installing Microsoft Visual C++ Redistributable..."
    File /oname=$PLUGINSDIR\vc_redist.x64.exe "${BUILD_RESOURCES_DIR}\vc_redist.x64.exe"
    ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /quiet /norestart' $0
    DetailPrint "VC++ Redistributable installer exit code: $0"
  skip_vc_redist:
!macroend
