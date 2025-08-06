const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
server.listen(PORT, () => console.log(`Server läuft auf http://localhost:${PORT}`));

app.use(express.static(__dirname + "/public"));

let rooms = {};

io.on("connection", (socket) => {
    socket.on("createRoom", ({ name, room, wolves, maxPlayers }) => {
        if (rooms[room]) {
            socket.emit("errorMessage", "Raum existiert bereits.");
            return;
        }

        rooms[room] = {
            host: socket.id,
            players: [{ id: socket.id, name, role: null, alive: true }],
            wolves,
            maxPlayers,
            started: false,
            phase: "lobby",
            wolfVotes: {},
            dayVotes: {},
            victims: [],
            readyForNextGame: []
        };

        socket.join(room);
        socket.data.room = room;

        // Rauminfo an den Spieler senden
        socket.emit("roomInfo", {
            maxPlayers: rooms[room].maxPlayers,
            players: rooms[room].players
        });

        io.to(room).emit("updatePlayerList", rooms[room].players.map(p => ({
            id: p.id,
            name: p.name,
            alive: p.alive
        })));
    });

    socket.on("joinRoom", ({ name, room }) => {
        const r = rooms[room];
        if (!r) {
            socket.emit("errorMessage", "Raum nicht gefunden.");
            return;
        }

        if (r.started && !r.readyForNextGame.includes(socket.id)) {
            socket.emit("errorMessage", "Spiel bereits gestartet.");
            return;
        }

        if (r.players.length >= r.maxPlayers) {
            socket.emit("errorMessage", "Raum ist voll.");
            return;
        }

        r.players.push({ id: socket.id, name, role: null, alive: true });
        socket.join(room);
        socket.data.room = room;

        // Rauminfo an den Spieler senden
        socket.emit("roomInfo", {
            maxPlayers: r.maxPlayers,
            players: r.players
        });

        io.to(room).emit("updatePlayerList", r.players.map(p => ({
            id: p.id,
            name: p.name,
            alive: p.alive
        })));

        if (r.players.length === r.maxPlayers) {
            r.started = true;
            setTimeout(() => startGame(room), 5000);
        }
    });

    socket.on("wolfVote", ({ room, target }) => {
        const r = rooms[room];
        if (!r || r.phase !== "night") return;

        const player = r.players.find(p => p.id === socket.id);
        if (!player || player.role !== "Werwolf" || !player.alive) return;

        // Vote speichern
        r.wolfVotes[socket.id] = target;

        // Allen Werwölfen die aktuellen Votes übermitteln
        const wolves = r.players.filter(p => p.role === "Werwolf" && p.alive);
        wolves.forEach(wolf => {
            io.to(wolf.id).emit("updateWolfVotes", r.wolfVotes);
        });

        // Prüfen, ob alle Werwölfe abgestimmt haben und das gleiche Ziel haben
        const allWolvesVoted = wolves.every(wolf => r.wolfVotes[wolf.id]);
        if (allWolvesVoted) {
            const votes = Object.values(r.wolfVotes);
            const allSameTarget = votes.every(v => v === votes[0]);

            if (allSameTarget) {
                // Opfer festlegen und zur Tagesphase übergehen
                const victim = r.players.find(p => p.id === votes[0]);
                if (victim) {
                    victim.alive = false;
                    r.victims.push(victim);

                    // Phase auf "announcement" setzen
                    r.phase = "announcement";

                    // Allen Spielern das Opfer mitteilen
                    io.to(room).emit("announceVictim", {
                        id: victim.id,
                        name: victim.name
                    });

                    // Spielstatus prüfen
                    checkGameStatus(room);
                }
            }
        }
    });

    socket.on("readyForDay", ({ room }) => {
        const r = rooms[room];
        if (!r || r.phase !== "announcement") return;

        // Phase auf "day" setzen
        r.phase = "day";
        r.dayVotes = {};

        // Tagesphase starten
        io.to(room).emit("startDay", {
            alivePlayers: r.players.filter(p => p.alive).map(p => ({
                id: p.id,
                name: p.name
            }))
        });
    });

    socket.on("dayVote", ({ room, target }) => {
        const r = rooms[room];
        if (!r || r.phase !== "day") return;

        const player = r.players.find(p => p.id === socket.id);
        if (!player || !player.alive) return;

        // Vote speichern
        r.dayVotes[socket.id] = target;

        // Prüfen, ob alle lebenden Spieler abgestimmt haben
        const alivePlayers = r.players.filter(p => p.alive);
        const allVoted = alivePlayers.every(p => r.dayVotes[p.id]);

        if (allVoted) {
            endDayPhase(room);
        }
    });

    socket.on("playAgain", ({ room, name }) => {
        const r = rooms[room];
        if (!r) return;

        // Spieler als bereit für nächstes Spiel markieren
        if (!r.readyForNextGame.includes(socket.id)) {
            r.readyForNextGame.push(socket.id);
        }

        // Update anderen Spielern, wer bereit ist
        io.to(room).emit("updatePlayerList", r.players.filter(p =>
            r.readyForNextGame.includes(p.id)
        ).map(p => ({
            id: p.id,
            name: p.name,
            alive: true
        })));

        // Wenn alle bereit sind und genug für ein Spiel, neues Spiel starten
        if (r.readyForNextGame.length >= Math.max(5, r.wolves + 3)) {
            // Spielerliste aktualisieren
            r.players = r.players.filter(p => r.readyForNextGame.includes(p.id));

            // Spielstatus zurücksetzen
            r.started = true;
            r.phase = "lobby";
            r.wolfVotes = {};
            r.dayVotes = {};
            r.victims = [];
            r.readyForNextGame = [];

            // Spiel starten
            setTimeout(() => startGame(room), 3000);
        }
    });

    socket.on("disconnect", () => {
        const room = socket.data.room;
        if (!room || !rooms[room]) return;

        // Spieler aus Ready-Liste entfernen
        if (rooms[room].readyForNextGame) {
            const readyIndex = rooms[room].readyForNextGame.indexOf(socket.id);
            if (readyIndex !== -1) {
                rooms[room].readyForNextGame.splice(readyIndex, 1);
            }
        }

        const index = rooms[room].players.findIndex(p => p.id === socket.id);
        if (index !== -1) {
            rooms[room].players.splice(index, 1);
            io.to(room).emit("updatePlayerList", rooms[room].players.map(p => ({
                id: p.id,
                name: p.name,
                alive: p.alive
            })));

            // Raum löschen, wenn leer
            if (rooms[room].players.length === 0) {
                delete rooms[room];
            }
            // Spiel beenden, wenn zu wenige Spieler
            else if (rooms[room].started && rooms[room].phase !== "lobby") {
                checkGameStatus(room);
            }
        }
    });
});

function startGame(room) {
    const r = rooms[room];
    if (!r) return;

    const shuffled = [...r.players].sort(() => Math.random() - 0.5);

    // Rollen zuweisen
    const wolfCount = Math.min(r.wolves, Math.floor(r.players.length / 3));
    for (let i = 0; i < wolfCount; i++) {
        shuffled[i].role = "Werwolf";
        shuffled[i].alive = true;
    }
    for (let i = wolfCount; i < shuffled.length; i++) {
        shuffled[i].role = "Dorfbewohner";
        shuffled[i].alive = true;
    }

    for (const player of shuffled) {
        io.to(player.id).emit("showRole", player.role);
    }

    // Nach 10 Sekunden die erste Nachtphase starten
    setTimeout(() => startNightPhase(room), 10000);
}

function startNightPhase(room) {
    const r = rooms[room];
    if (!r) return;

    r.phase = "night";
    r.wolfVotes = {};

    io.to(room).emit("startNight");
}

function endDayPhase(room) {
    const r = rooms[room];
    if (!r) return;

    // Votes zählen
    const voteCounts = {};
    for (const targetId of Object.values(r.dayVotes)) {
        voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    }

    // Spieler mit den meisten Stimmen finden
    let maxVotes = 0;
    let mostVoted = null;

    for (const [targetId, count] of Object.entries(voteCounts)) {
        if (count > maxVotes) {
            maxVotes = count;
            mostVoted = targetId;
        }
    }

    if (mostVoted) {
        const victim = r.players.find(p => p.id === mostVoted);
        if
