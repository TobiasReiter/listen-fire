//! A toy game that scripts its world with a movement: when a monster is
//! slain the slayer gets a trophy at once, and an hour of game time later a
//! herald announces it. The game's world is the movement's one adapter;
//! every other host the engine needs (its parks, its clock, its trace) is a
//! few lines of memory here.

use listen_fire::engine::embed::{
    self, AdapterCall, AdapterInstance, AdapterReply, AdapterRequest, Adapters, Catalog, Clock, Data, Event, HostResult, Hosts, Outcome, ParkedState,
    RunInput, Store, TimerPark, Trace,
};

/// The movement the game ships with, as a level designer would write it.
pub const SCRIPT: &str = r#"import { world } from adapters

game = connect world

# A monster slain: its slayer gets a trophy at once, and an hour of game
# time later the herald announces the deed.
function slain(monster: <game-[:Monster]->>) {
  write game-[:trophies]-> { Name: "${monster.Name} trophy", Owner: monster.Slayer }
  await sleep(1h)
  write game-[:announcements]-> { Text: "${monster.Slayer} slew the ${monster.Name}" }
}

listen to game { events: ["monster.slain"] } fire slain
"#;

/// What the world adapter offers a movement: one event position and two
/// record types it may create.
pub const CATALOG: &str = r#"{
  "adapters": { "world": { "constructionArgs": [], "canFire": true, "triggerConfig": ["events"], "schemas": { "": {
    "positions": {
      "Monster": { "properties": { "Name": "text", "Slayer": "text" }, "edges": {} },
      "Trophy": { "properties": { "Name": "text", "Owner": "text" }, "edges": {} },
      "Announcement": { "properties": { "Text": "text" }, "edges": {} }
    },
    "collections": { "trophies": { "target": "Trophy" }, "announcements": { "target": "Announcement" } },
    "eventPosition": "Monster",
    "writableRoots": {
      "Trophy": { "fields": { "Name": "text", "Owner": "text" }, "resultShape": { "externalId": "text" } },
      "Announcement": { "fields": { "Text": "text" }, "resultShape": { "externalId": "text" } }
    }
  } } } },
  "credentials": {},
  "plugins": {}
}"#;

/// Something that happened in the game.
#[derive(Debug, Clone)]
pub enum GameEvent {
    MonsterSlain { monster: String, by: String },
}

/// The world's records, as the movement made them.
#[derive(Debug, Default)]
pub struct World {
    pub trophies: Vec<(String, String)>,
    pub announcements: Vec<String>,
    next_id: u32,
}

impl Adapters for World {
    fn resolve(&mut self, request: AdapterRequest) -> HostResult<AdapterInstance> {
        match request.adapter_type.as_str() {
            "world" => Ok(AdapterInstance { id: "world".into(), methods: vec!["createRecord".into()] }),
            other => Err(format!("the game has no adapter {other}").into()),
        }
    }

    fn call(&mut self, call: AdapterCall) -> HostResult<AdapterReply> {
        match call.method.as_str() {
            // The event's own record is the position the movement reads.
            "getFieldValue" => {
                let field = call.args.get("fieldId").and_then(Data::as_text).unwrap_or_default().to_string();
                let data = call.args.get("position").and_then(|p| p.get("identity")).and_then(|i| i.get("data")).cloned();
                Ok(AdapterReply::ok(data.and_then(|d| d.get(&field).cloned()).unwrap_or(Data::Null)))
            }
            "createRecord" => {
                let record_type = call.args.get("recordType").and_then(Data::as_text).unwrap_or_default().to_string();
                let fields = call.args.get("fields").cloned().unwrap_or(Data::Null);
                let field = |name: &str| fields.get(name).and_then(Data::as_text).unwrap_or_default().to_string();
                match record_type.as_str() {
                    "Trophy" => self.trophies.push((field("Name"), field("Owner"))),
                    "Announcement" => self.announcements.push(field("Text")),
                    other => return Ok(AdapterReply::error("adapter_error", format!("the world makes no {other}"))),
                }
                self.next_id += 1;
                Ok(AdapterReply::ok(Data::map([
                    ("adapterType", Data::text("world")),
                    ("externalId", Data::text(format!("{}-{}", record_type.to_lowercase(), self.next_id))),
                    ("recordType", Data::text(record_type)),
                    ("data", fields),
                ])))
            }
            "describe" => Ok(AdapterReply::ok(Data::Null)),
            // Nothing in the world is the same record twice: every write creates.
            "resolveEntity" => Ok(AdapterReply::ok(Data::map([("candidates", Data::List(Vec::new()))]))),
            other => Ok(AdapterReply::error("adapter_error", format!("the world does not answer {other}"))),
        }
    }
}

/// Parked flows waiting on game time.
#[derive(Debug, Default)]
pub struct Parks {
    pub timers: Vec<TimerPark>,
}

impl Store for Parks {
    fn keeps_parks(&self) -> bool {
        true
    }
    fn commit_timer_park(&mut self, park: TimerPark) -> HostResult<()> {
        self.timers.push(park);
        Ok(())
    }
    fn cancel_subtrees(&mut self, prefixes: &[String], exclude: Option<&str>) -> HostResult<()> {
        self.timers.retain(|t| Some(t.address.as_str()) == exclude || !prefixes.iter().any(|p| t.address.starts_with(p.as_str())));
        Ok(())
    }
    fn save_source(&mut self, source: &str) -> HostResult<String> {
        Ok(format!("src-{}", source.len()))
    }
}

/// Game time, in minutes from the start of the campaign.
#[derive(Debug, Default)]
pub struct GameClock {
    pub minutes: u32,
    next_id: u64,
}

impl GameClock {
    pub fn iso(&self) -> String {
        iso(self.minutes)
    }
}

/// Game time as an instant (a campaign shorter than a month), so instants
/// compare as their texts do.
pub fn iso(minutes: u32) -> String {
    format!("2026-01-{:02}T{:02}:{:02}:00.000Z", 1 + minutes / 1440, minutes / 60 % 24, minutes % 60)
}

impl Clock for GameClock {
    fn now_iso(&mut self) -> String {
        self.iso()
    }
    fn mint_ids(&mut self, count: usize) -> Vec<String> {
        (0..count)
            .map(|_| {
                self.next_id += 1;
                format!("g{}", self.next_id)
            })
            .collect()
    }
}

#[derive(Debug, Default)]
pub struct Log {
    pub entries: usize,
}

impl Trace for Log {
    fn append(&mut self, entries: Vec<Data>) -> HostResult<()> {
        self.entries += entries.len();
        Ok(())
    }
}

/// The game: its world, its scripts and the hosts they run on.
pub struct Game {
    pub world: World,
    pub parks: Parks,
    pub clock: GameClock,
    pub log: Log,
    script: String,
    catalog: Catalog,
    listens: Vec<embed::Listen>,
    /// Each parked run's input, by the address its flow parked at.
    parked: Vec<(String, RunInput)>,
    pub failures: Vec<String>,
}

impl Game {
    /// The game with its script loaded and checked.
    pub fn new(script: &str) -> Result<Game, String> {
        let catalog = Catalog::from_json(CATALOG)?;
        let problems: Vec<_> = embed::check(script, &catalog, embed::LANGUAGE_VERSION).into_iter().filter(|p| p.severity == embed::Severity::Error).collect();
        if !problems.is_empty() {
            return Err(problems.iter().map(|p| format!("{}:{} {} {}", p.line, p.column, p.code, p.message)).collect::<Vec<_>>().join("\n"));
        }
        let listens = embed::listens(script, embed::LANGUAGE_VERSION)?;
        Ok(Game { world: World::default(), parks: Parks::default(), clock: GameClock::default(), log: Log::default(), script: script.to_string(), catalog, listens, parked: Vec::new(), failures: Vec::new() })
    }

    /// An in-game event: every listen that chooses it fires.
    pub fn fire(&mut self, event: GameEvent) {
        let GameEvent::MonsterSlain { monster, by } = event;
        let event = Event::new("world", Data::map([("Name", Data::text(&monster)), ("Slayer", Data::text(by))])).of_type("monster.slain").about("Monster", monster);
        let functions: Vec<String> = self
            .listens
            .iter()
            .filter(|l| l.adapter == "world" && (l.events.is_empty() || l.events.iter().any(|e| Some(e) == event.event_type.as_ref())))
            .map(|l| l.function.clone())
            .collect();
        for function in functions {
            let input = RunInput::new(self.script.clone(), event.clone(), self.clock.iso()).function(function).catalog(self.catalog.clone());
            self.settle(&input, None);
        }
    }

    /// One tick of game time: every park now due resumes.
    pub fn tick(&mut self, minutes: u32) {
        self.clock.minutes += minutes;
        let now = self.clock.iso();
        let (due, waiting): (Vec<_>, Vec<_>) = std::mem::take(&mut self.parks.timers).into_iter().partition(|t| t.wake_at <= now);
        self.parks.timers = waiting;
        for park in due {
            let Some(index) = self.parked.iter().position(|(address, _)| *address == park.address) else { continue };
            let (_, input) = self.parked.remove(index);
            self.settle(&input, Some(park.state));
        }
    }

    fn settle(&mut self, input: &RunInput, state: Option<ParkedState>) {
        let mut hosts = Hosts::new().adapters(&mut self.world).store(&mut self.parks).clock(&mut self.clock).trace(&mut self.log);
        let outcome = match &state {
            None => embed::run(&mut hosts, input),
            Some(state) => embed::resume(&mut hosts, input, state),
        };
        match outcome {
            Ok(Outcome::Parked(ran)) => self.parked.push((ran.parked_address.unwrap_or_default(), input.clone())),
            Ok(Outcome::Finished(_) | Outcome::Cancelled(_)) => {}
            Ok(Outcome::Failed(failure)) => self.failures.push(format!("{:?} {}", failure.code, failure.message)),
            Ok(Outcome::Refused(reason)) => self.failures.push(format!("refused: {reason}")),
            Err(error) => self.failures.push(error.to_string()),
        }
    }
}
