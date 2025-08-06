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
            players: [{ id: socket.id, name, role: null }],
            wolves,
            maxPlayers,
            started: false
        };

        socket.join(room);
        io.to(room).emit("updatePlayerList", rooms[room].players.map(p => p.name));
    });

    socket.on("joinRoom", ({ name, room }) => {
        const r = rooms[room];
        if (!r) {
            socket.emit("errorMessage", "Raum nicht gefunden.");
            return;
        }

        if (r.started) {
            socket.emit("errorMessage", "Spiel bereits gestartet.");
            return;
        }

        if (r.players.length >= r.maxPlayers) {
            socket.emit("errorMessage", "Raum ist voll.");
            return;
        }

        r.players.push({ id: socket.id, name, role: null });
        socket.join(room);
        io.to(room).emit("updatePlayerList", r.players.map(p => p.name));

        if (r.players.length === r.maxPlayers) {
            r.started = true;
            setTimeout(() => startGame(room), 5000);
        }
    });

    socket.on("disconnect", () => {
        for (const [room, data] of Object.entries(rooms)) {
            const index = data.players.findIndex(p => p.id === socket.id);
            if (index !== -1) {
                data.players.splice(index, 1);
                io.to(room).emit("updatePlayerList", data.players.map(p => p.name));
                if (data.players.length === 0) delete rooms[room];
                break;
            }
        }
    });
});

function startGame(room) {
    const r = rooms[room];
    if (!r) return;

    const shuffled = [...r.players].sort(() => Math.random() - 0.5);
    for (let i = 0; i < r.wolves; i++) {
        shuffled[i].role = "Werwolf";
    }
    for (let i = r.wolves; i < shuffled.length; i++) {
        shuffled[i].role = "Dorfbewohner";
    }

    for (const player of shuffled) {
        io.to(player.id).emit("showRole", player.role);
    }
}
