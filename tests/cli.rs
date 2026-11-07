use std::process::Command;

#[test]
fn import_reports_failure_but_still_imports_other_files() {
    let temp = tempfile::tempdir().unwrap();
    let good = temp.path().join("guide.txt");
    std::fs::write(&good, "A small book about the quiet sea.").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_omareader"))
        .env("OMAREADER_DATA_DIR", temp.path().join("library"))
        .arg("import")
        .arg(temp.path().join("missing.epub"))
        .arg(&good)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("1 file(s) could not be imported"));
    assert!(String::from_utf8_lossy(&output.stdout).contains("imported"));
    let success = Command::new(env!("CARGO_BIN_EXE_omareader"))
        .env("OMAREADER_DATA_DIR", temp.path().join("library"))
        .arg("import")
        .arg(&good)
        .output()
        .unwrap();
    assert!(success.status.success());
}
