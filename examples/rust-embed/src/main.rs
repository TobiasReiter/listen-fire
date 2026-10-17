//! `cargo run -p rust-embed-example`: a few ticks of the toy game.

use rust_embed_example::{Game, GameEvent, SCRIPT};

fn main() {
    let mut game = match Game::new(SCRIPT) {
        Ok(game) => game,
        Err(problems) => {
            eprintln!("the script does not check:\n{problems}");
            std::process::exit(1);
        }
    };
    game.fire(GameEvent::MonsterSlain { monster: "Dragon".into(), by: "Ada".into() });
    for _ in 0..8 {
        game.tick(15);
        println!("{} trophies {:?}, announcements {:?}", game.clock.iso(), game.world.trophies, game.world.announcements);
    }
    for failure in &game.failures {
        eprintln!("failed: {failure}");
    }
}
