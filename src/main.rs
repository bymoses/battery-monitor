mod app;
mod cli;
mod collect;
mod config;
mod db;
mod install;
mod migrate;
mod server;
mod util;

use anyhow::Result;
use clap::Parser;

use cli::{Cli, Commands};

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Start(args) => app::start(args).await,
        Commands::Install(args) => install::install(args),
        Commands::Migrate(args) => migrate::migrate(args),
    }
}
