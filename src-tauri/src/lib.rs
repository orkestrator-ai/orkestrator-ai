// Claude Code Environment Orchestrator - Rust Backend
// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

mod claude_cli;
mod commands;
mod credentials;
mod docker;
mod models;
mod pty;
mod storage;

use commands::*;
use bollard::Docker;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Emitter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize terminal manager if Docker is available
    if Docker::connect_with_local_defaults().is_ok() {
        pty::init_terminal_manager();
        println!("[init] Terminal manager initialized");
    } else {
        println!("[init] Warning: Could not initialize terminal manager - Docker not available");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Create App menu with About and Quit (CMD+Q)
            let app_menu = SubmenuBuilder::new(app, "Orkestrator AI")
                .item(&PredefinedMenuItem::about(app, Some("About Orkestrator AI"), None)?)
                .separator()
                .item(&PredefinedMenuItem::hide(app, None)?)
                .item(&PredefinedMenuItem::hide_others(app, None)?)
                .item(&PredefinedMenuItem::show_all(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::quit(app, None)?)
                .build()?;

            // Create Edit menu with standard editing shortcuts
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .item(&PredefinedMenuItem::undo(app, None)?)
                .item(&PredefinedMenuItem::redo(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::cut(app, None)?)
                .item(&PredefinedMenuItem::copy(app, None)?)
                .item(&PredefinedMenuItem::paste(app, None)?)
                .item(&PredefinedMenuItem::select_all(app, None)?)
                .build()?;

            // Create View menu with zoom controls
            let zoom_in = MenuItemBuilder::with_id("zoom_in", "Zoom In")
                .accelerator("CmdOrCtrl+=")
                .build(app)?;

            let zoom_out = MenuItemBuilder::with_id("zoom_out", "Zoom Out")
                .accelerator("CmdOrCtrl+-")
                .build(app)?;

            let zoom_reset = MenuItemBuilder::with_id("zoom_reset", "Actual Size")
                .accelerator("CmdOrCtrl+0")
                .build(app)?;

            let view_menu = SubmenuBuilder::new(app, "View")
                .item(&zoom_in)
                .item(&zoom_out)
                .separator()
                .item(&zoom_reset)
                .build()?;

            let menu = MenuBuilder::new(app)
                .items(&[&app_menu, &edit_menu, &view_menu])
                .build()?;

            app.set_menu(menu)?;

            // Handle menu events
            app.on_menu_event(move |app_handle, event| {
                match event.id().0.as_str() {
                    "zoom_in" => {
                        let _ = app_handle.emit("menu-zoom", "in");
                    }
                    "zoom_out" => {
                        let _ = app_handle.emit("menu-zoom", "out");
                    }
                    "zoom_reset" => {
                        let _ = app_handle.emit("menu-zoom", "reset");
                    }
                    _ => {}
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            // Project commands
            get_projects,
            add_project,
            remove_project,
            get_project,
            update_project,
            reorder_projects,
            validate_git_url,
            get_git_remote_url,
            // Environment commands
            get_environments,
            reorder_environments,
            create_environment,
            delete_environment,
            get_environment,
            update_environment_status,
            set_environment_pr,
            set_environment_debug_mode,
            rename_environment,
            get_environment_status,
            start_environment,
            stop_environment,
            recreate_environment,
            sync_environment_status,
            sync_all_environments_with_docker,
            add_environment_domains,
            remove_environment_domains,
            update_environment_allowed_domains,
            // Port mapping commands
            update_port_mappings,
            // Docker commands
            check_docker,
            docker_version,
            provision_environment,
            docker_start_container,
            docker_stop_container,
            docker_remove_container,
            docker_container_status,
            list_docker_containers,
            check_base_image,
            get_docker_system_stats,
            get_orkestrator_containers,
            cleanup_orphaned_containers,
            docker_system_prune,
            get_container_logs,
            stream_container_logs,
            get_container_host_port,
            // Terminal commands
            attach_terminal,
            create_terminal_session,
            start_terminal_session,
            terminal_write,
            terminal_resize,
            detach_terminal,
            list_terminal_sessions,
            get_terminal_session,
            // Session commands (persistent session tracking)
            create_session,
            get_session,
            get_sessions_by_environment,
            update_session_status,
            update_session_activity,
            delete_session,
            delete_sessions_by_environment,
            rename_session,
            set_session_has_launched_command,
            disconnect_environment_sessions,
            save_session_buffer,
            load_session_buffer,
            sync_sessions_with_container,
            reorder_sessions,
            cleanup_orphaned_buffers,
            // GitHub commands
            open_in_browser,
            get_environment_pr_url,
            clear_environment_pr,
            detect_pr_url,
            detect_pr,
            merge_pr,
            // Config commands
            get_config,
            save_config,
            get_global_config,
            update_global_config,
            get_repository_config,
            update_repository_config,
            // Credentials commands
            has_claude_credentials,
            get_credential_status,
            // CLI detection and onboarding commands
            check_claude_cli,
            check_claude_config,
            check_opencode_cli,
            check_github_cli,
            check_any_ai_cli,
            get_available_ai_cli,
            // Network commands
            test_domain_resolution,
            validate_domains,
            // Claude state commands
            start_claude_state_polling,
            stop_claude_state_polling,
            // Editor commands
            open_in_editor,
            // File commands
            get_git_status,
            get_file_tree,
            read_container_file,
            read_file_at_branch,
            read_container_file_base64,
            write_container_file,
            // OpenCode commands
            start_opencode_server,
            stop_opencode_server,
            get_opencode_server_status,
            get_opencode_server_log,
            // Claude bridge commands
            start_claude_server,
            stop_claude_server,
            get_claude_server_status,
            get_claude_server_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
