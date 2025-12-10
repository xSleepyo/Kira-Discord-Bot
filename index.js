const Discord = require("discord.js");
const { Client } = require("pg");
const express = require("express");
const axios = require("axios");
const { PermissionFlagsBits, Events } = require("discord.js");

// --- Global Crash Handlers ---
process.on("unhandledRejection", (error) => {
    console.error("CRITICAL UNHANDLED PROMISE REJECTION:", error);
});

process.on("uncaughtException", (error) => {
    console.error("CRITICAL UNCAUGHT EXCEPTION:", error);
    try {
        client.destroy();
    } catch (e) {
        console.error("Failed to destroy client:", e);
    }
    process.exit(1);
});
// -----------------------------

// Command Prefix
const PREFIX = ".";

// Global memory store for embed drafts
const userEmbedDrafts = {};

// --- CRITICAL FIX: FLAG TO PREVENT DOUBLE INITIALIZATION / DOUBLE PROCESSES ---
let botInitialized = false;

// --- STATUS COMMAND COOLDOWN LOCK ---
// Used to block the second bot instance from executing the command immediately after the first.
const statusCooldown = new Set();
const COOLDOWN_TIME = 2000; // 2 seconds

// ANSI Color Map
const COLOR_MAP = {
    RED: 0xff0000,
    GREEN: 0x00ff00,
    BLUE: 0x0000ff,
    YELLOW: 0xffff00,
    PURPLE: 0x9b59b6,
    CYAN: 0x00ffff,
    DEFAULT: 0x3498db,
};

// --- Ship Name Generator (Required for .ship command) ---
function generateShipName(name1, name2) {
    const len1 = name1.length;
    const len2 = name2.length;
    const half1 = Math.ceil(len1 / 2);
    const half2 = Math.ceil(len2 / 2);
    const part1 = name1.substring(0, half1);
    const part2 = name2.substring(len2 - half2);
    return part1 + part2;
}

// Magic 8-Ball Responses 
const eightBallResponses = [
    "It is certain.",
    "It is decidedly so.",
    "Without a doubt.",
    "Yes, definitely.",
    "You may rely on it.",
    "As I see it, yes.",
    "Most likely.",
    "Outlook good.",
    "Yes.",
    "Signs point to yes.",
    "Reply hazy, try again.",
    "Ask again later.",
    "Better not tell you now.",
    "Cannot predict now.",
    "Concentrate and ask again.",
    "Don't count on it.",
    "My reply is no.",
    "My sources say no.",
    "Outlook not so good.",
    "Very doubtful.",
];

// Connect to the PostgreSQL database
const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false,
    },
});

// Global variables for in-memory access
let countingChannelId = null;
let nextNumber = 1;

const client = new Discord.Client({
    intents: [
        Discord.GatewayIntentBits.Guilds,
        Discord.GatewayIntentBits.GuildMessages,
        Discord.GatewayIntentBits.MessageContent,
        Discord.GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [
        Discord.Partials.Message,
        Discord.Partials.Channel,
        Discord.Partials.Reaction,
    ],
});

const token = process.env.TOKEN;

// -------------------------------------------------------------
// UPTIME AND DATABASE FUNCTIONS
// -------------------------------------------------------------

// --- Server Setup ---
const app = express();

function keepAlive() {
    app.get("/", (req, res) => {
        res.send("Bot is Alive!");
    });
    app.listen(process.env.PORT || 3000, () => {
        console.log(`Web server running on port ${process.env.PORT || 3000}`);
    });
}

// --- Self-Pinging Function (using axios) ---
function selfPing() {
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`; 

    setInterval(async () => {
        try {
            const res = await axios.get(url); 
            console.log(`Self-Ping successful. Status: ${res.status}`);
        } catch (error) {
            console.error(`Self-Ping Error: ${error.message}`);
        }
    }, 180000); // Ping every 3 minutes
} 

async function setupDatabase() {
    try {
        await db.connect();
        console.log("✅ PostgreSQL Database connected.");

        await db.query(`
            CREATE TABLE IF NOT EXISTS counting (
                id INTEGER PRIMARY KEY,
                channel_id TEXT,
                next_number INTEGER
            );
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS reaction_roles (
                id SERIAL PRIMARY KEY,
                guild_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                channel_id TEXT NOT NULL,
                emoji_name TEXT NOT NULL,
                role_id TEXT NOT NULL,
                UNIQUE (message_id, emoji_name)
            );
        `);
        console.log("✅ Database tables ensured.");
    } catch (error) {
        console.error(
            "CRITICAL ERROR: Failed to connect or setup database!",
            error,
        );
        throw error; 
    }
}

async function loadState() {
    try {
        const result = await db.query(
            "SELECT channel_id, next_number FROM counting WHERE id = 1",
        );

        if (result.rows.length > 0) {
            const row = result.rows[0];
            countingChannelId = row.channel_id || null;
            nextNumber = parseInt(row.next_number) || 1;
        } else {
            await db.query(
                `
                INSERT INTO counting (id, channel_id, next_number)
                VALUES (1, $1, $2)
                ON CONFLICT (id) DO NOTHING;
            `,
                [null, 1],
            );
        }

        console.log(
            `[DB] Loaded Channel ID: ${countingChannelId}, Next Number: ${nextNumber}`,
        );
    } catch (error) {
        console.error("CRITICAL ERROR: Failed to load database state!", error);
        throw error;
    }
}

async function saveState(channelId, nextNum) {
    try {
        await db.query(
            `
            UPDATE counting
            SET channel_id = $1, next_number = $2
            WHERE id = 1;
        `,
            [channelId, nextNum],
        );
    } catch (error) {
        console.error("CRITICAL ERROR: Failed to save database state!", error);
    }
}

async function initializeBot() {
    // --- PROCESS-LEVEL GUARD (prevents same process initialization) ---
    if (botInitialized) {
        console.log("Bot initialization skipped: another process is likely running.");
        return;
    }
    botInitialized = true;
    console.log("Bot initialization started...");
    // ------------------------------------------

    try {
        await setupDatabase();
        await loadState();

        keepAlive(); // Starts the web server
        selfPing(); // Starts the internal self-ping loop for continuous activity
        client.login(token);
    } catch (error) {
        // If setup or load fails, log and prevent login
        console.error("Bot failed to initialize due to critical error:", error);
        botInitialized = false; // Reset flag so a restart attempt is possible
    }
}

// -------------------------------------------------------------
// Handle Text Messages - GLOBAL LISTENER
// -------------------------------------------------------------
client.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    const content = message.content;
    const command = content.toLowerCase();

    // --- Counting Logic Check ---
    if (countingChannelId && message.channel.id === countingChannelId) {
        const number = parseInt(content);

        if (isNaN(number)) {
            return;
        }

        if (number === nextNumber) {
            try {
                await new Promise((resolve) => setTimeout(resolve, 750));
                await message.react("✔️");

                nextNumber++;
                await saveState(countingChannelId, nextNumber);
            } catch (error) {
                console.error(
                    `Failed to react to message ID ${message.id}:`,
                    error,
                );

                nextNumber++;
                await saveState(countingChannelId, nextNumber);
            }
        } else {
            message.channel
                .send(
                    `Wrong Number! The next number was **${nextNumber}**. Try again.`,
                )
                .then((msg) => {
                    setTimeout(() => msg.delete().catch(console.error), 3000);
                });

            setTimeout(() => message.delete().catch(console.error), 3000);
        }
    }

    // Check for the prefix
    if (!command.startsWith(PREFIX)) return;

    const rawArgs = message.content.slice(PREFIX.length).trim();
    const args = rawArgs.split(/ +/);
    const commandName = args.shift().toLowerCase();

    // --- Command: .help ---
    if (commandName === "help") {
        const helpEmbed = new Discord.EmbedBuilder()
            .setColor(0x3498db)
            .setTitle("Kira Bot Commands")
            .setDescription("Here is a list of commands you can use:")
            .addFields(
                {
                    name: "Admin Commands (Slash)",
                    value: "`/countinggame` - Setup the counting channel.\n`/resetcounting` - Reset the count to 1.\n`/embed` - Starts an interactive conversation to build an embed.\n`/reactionrole` - Set up a reaction role on a message.",
                    inline: false,
                },
                {
                    name: "Moderation & Utility (Admin Required)",
                    value: "`.purge [number]` - Delete messages.",
                    inline: false,
                },
                {
                    name: "General Utility",
                    value: "`.status` - Check the bot's ping and uptime.\n`.userinfo [user]` - Get information about a user.",
                    inline: false,
                },
                {
                    name: "Counting Game",
                    value: "Just post the next number in the counting channel!",
                    inline: false,
                },
                {
                    name: "Fun Commands",
                    value: "`.joke` - Get a random joke.\n`.8ball [question]` - Ask the magic 8-ball a question.\n`.flip` - Flip a coin (Heads or Tails).\n`.ship [user]` - Calculate compatibility.",
                    inline: false,
                },
            )
            .setFooter({ text: `Prefix: ${PREFIX}` });

        message.channel.send({ embeds: [helpEmbed] });
    }

    // --- Command: .ship ---
    else if (commandName === "ship") {
        const user1 = message.author;

        let user2 = message.mentions.users.first();

        if (!user2) {
            user2 = client.user;
        }

        if (user1.id === user2.id) {
            return message.channel.send(
                "You cannot ship yourself with yourself! Mention someone else.",
            );
        }

        const seed = user1.id.slice(0, 5) + user2.id.slice(0, 5);
        let hash = 0;
        for (let i = 0; i < seed.length; i++) {
            hash = seed.charCodeAt(i) + ((hash << 5) - hash);
        }
        const compatibility = Math.abs(hash % 101); // 0 to 100%

        const name1 = user1.username.replace(/[^a-z0-9]/gi, "");
        const name2 = user2.username.replace(/[^a-z0-9]/gi, "");
        const shipName = generateShipName(name1, name2);

        let shipColor = 0xff0000;
        let description = `Compatibility between **${user1.username}** and **${user2.username}**.`;

        if (compatibility >= 90) {
            shipColor = 0x00ff00;
            description = `A perfect match! Soulmates detected!`;
        } else if (compatibility >= 60) {
            shipColor = 0xffa500;
            description = `A strong connection! This ship has smooth sailing ahead.`;
        } else if (compatibility >= 30) {
            shipColor = 0xffff00;
            description = `There's potential, but watch out for a few icebergs.`;
        }

        const shipEmbed = new Discord.EmbedBuilder()
            .setColor(shipColor)
            .setTitle(`Compatibility Calculator`)
            .setDescription(description)
            .addFields(
                { name: "Pair", value: `${user1} + ${user2}`, inline: false },
                {
                    name: "Ship Name",
                    value: `**${shipName.charAt(0).toUpperCase() + shipName.slice(1)}**`,
                    inline: false,
                },
                {
                    name: "Compatibility",
                    value: `**${compatibility}%**`,
                    inline: false,
                },
            )
            .setFooter({ text: `Requested by ${message.author.tag}` });

        message.channel.send({ embeds: [shipEmbed] });
    }

    // --- Command: .purge ---
    else if (commandName === "purge") {
        if (
            !message.member.permissions.has(
                Discord.PermissionFlagsBits.ManageMessages,
            )
        ) {
            return message.channel.send(
                "❌ You do not have permission to manage messages.",
            );
        }
        const amount = parseInt(args[0]);

        if (isNaN(amount) || amount <= 0 || amount > 100) {
            return message.channel.send(
                "Please provide a number between 1 and 100 for messages to delete.",
            );
        } 

        try {
            const deleted = await message.channel.bulkDelete(amount, true);

            const confirmMsg = await message.channel.send(
                `✅ Successfully deleted ${deleted.size} messages.`,
            );

            setTimeout(() => confirmMsg.delete().catch(console.error), 5000);
        } catch (error) {
            console.error("Error during purge:", error);
            message.channel.send(
                '❌ I was unable to delete messages. Make sure my role has "Manage Messages" permission.',
            );
        }
    }

    // --- Command: .flip ---
    else if (commandName === "flip") {
        const outcome = Math.random() < 0.5 ? "Heads" : "Tails";
        message.channel.send(`🪙 The coin landed on **${outcome}**!`);
    }

    // --- Command: .userinfo ---
    else if (commandName === "userinfo") {
        const member = message.mentions.members.first() || message.member;
        const user = member.user;

        const roles =
            member.roles.cache
                .filter((role) => role.id !== message.guild.id)
                .map((role) => role.toString())
                .join(", ") || "None";

        const userInfoEmbed = new Discord.EmbedBuilder()
            .setColor(member.displayHexColor || 0x3498db)
            .setTitle(`User Information: ${user.tag}`)
            .setThumbnail(user.displayAvatarURL({ dynamic: true }))
            .addFields(
                { name: "User ID", value: user.id, inline: false },
                {
                    name: "Account Creation Date",
                    value: `<t:${Math.floor(user.createdAt.getTime() / 1000)}:R>`,
                    inline: false,
                },
                {
                    name: "Joined Server Date",
                    value: `<t:${Math.floor(member.joinedAt.getTime() / 1000)}:R>`,
                    inline: false,
                },
                { name: "Roles", value: roles, inline: false },
            )
            .setFooter({ text: `Requested by ${message.author.tag}` });

        message.channel.send({ embeds: [userInfoEmbed] });
    }

    // --- Command: .8ball ---
    else if (commandName === "8ball") {
        const question = args.join(" ");

        if (!question) {
            return message.channel.send(
                "Please ask the magic 8-ball a question!",
            );
        }

        const randomIndex = Math.floor(
            Math.random() * eightBallResponses.length,
        );
        const response = eightBallResponses[randomIndex];

        const eightBallEmbed = new Discord.EmbedBuilder()
            .setColor(0x9b59b6)
            .setTitle("Magic 8-Ball")
            .addFields(
                { name: "Question", value: question, inline: false },
                { name: "Answer", value: response, inline: false },
            )
            .setFooter({ text: `Asked by ${message.author.tag}` });

        message.channel.send({ embeds: [eightBallEmbed] });
    }

    // --- Command: .status (NOW WITH COOLDOWN LOCK) ---
    else if (commandName === "status") {
        // --- COOLDOWN CHECK ---
        if (statusCooldown.has(message.channel.id)) {
            // Likely the duplicate execution from the second process, so we ignore it.
            return; 
        }
        
        // Lock the channel for 2 seconds
        statusCooldown.add(message.channel.id);
        setTimeout(() => {
            statusCooldown.delete(message.channel.id);
        }, COOLDOWN_TIME);

        // Uptime calculation (existing)
        let totalSeconds = client.uptime / 1000;
        let days = Math.floor(totalSeconds / 86400);
        totalSeconds %= 86400;
        let hours = Math.floor(totalSeconds / 3600);
        totalSeconds %= 3600;
        let minutes = Math.floor(totalSeconds / 60);
        let seconds = Math.floor(totalSeconds % 60);

        const uptimeString = `${days}d, ${hours}h, ${minutes}m, ${seconds}s`;
        
        // NEW: Get memory usage (in MB)
        const memoryUsage = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
        
        // NEW: Get server count
        const serverCount = client.guilds.cache.size;

        const statusEmbed = new Discord.EmbedBuilder()
            .setColor(0x00ff00)
            .setTitle("Bot Status Report")
            .setFooter({ text: "Updated Live" })
            .setTimestamp()
            .addFields(
                {
                    name: "**Connection**",
                    // Using ANSI code format that Discord renders
                    value: "```ansi\n\x1b[0;32mOnline\x1b[0m\n```",
                    inline: true,
                },
                {
                    name: "**Ping**",
                    value: `\`\`\`ansi\n\x1b[0;32m${client.ws.ping}ms\x1b[0m\n\`\`\``,
                    inline: true,
                },
                // --- NEW METRICS ---
                {
                    name: "**Servers**",
                    value: `\`\`\`ansi\n\x1b[0;32m${serverCount}\x1b[0m\n\`\`\``,
                    inline: true,
                },
                {
                    name: "**Memory**",
                    value: `\`\`\`ansi\n\x1b[0;32m${memoryUsage} MB\x1b[0m\n\`\`\``,
                    inline: true,
                },
                // --- EXISTING ---
                {
                    name: "**Uptime**",
                    value: `\`\`\`ansi\n\x1b[0;32m${uptimeString}\x1b[0m\n\`\`\``,
                    inline: false,
                },
            );

        message.channel.send({ embeds: [statusEmbed] });
    }

    // --- Command: .joke ---
    else if (commandName === "joke") {
        try {
            const response = await axios.get(
                "https://v2.jokeapi.dev/joke/Any?blacklistFlags=racist,sexist,explicit&type=single",
            );
            const joke = response.data.joke;

            if (joke) {
                message.channel.send(`**Here's a joke!**\n\n${joke}`);
            } else {
                message.channel.send(
                    "Sorry, I couldn't fetch a joke right now.",
                );
            }
        } catch (error) {
            console.error("Error fetching joke:", error);
            message.channel.send(
                "My joke generator seems to be taking a nap. Try again later!",
            );
        }
    }

    // --- Simple Aliases: Hello! or Hey! ---
    else if (command === "hello!" || command === "hey!") {
        message.channel.send("Hey!, how are you?");
    }
});
// -------------------------------------------------------------
// Register Slash Commands
// -------------------------------------------------------------
client.on(Events.ClientReady, async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    // --- SET BOT STATUS ---
    client.user.setPresence({
        activities: [
            {
                name: "🎧 Listening to xSleepyo",
                type: Discord.ActivityType.Custom,
            },
        ],
        status: "online",
    });
    // ------------------------------------------

    // --- Define and Register Commands ---
    const commands = [
        // Counting Game Commands
        {
            name: "countinggame",
            description:
                "Sets up the counting game in a specified channel (Admin/Owner only).",
            options: [
                {
                    name: "channel",
                    description:
                        "The channel where the counting game will take place.",
                    type: Discord.ApplicationCommandOptionType.Channel,
                    required: true,
                },
            ],
            default_member_permissions:
                PermissionFlagsBits.Administrator.toString(),
        },
        {
            name: "resetcounting",
            description:
                "Resets the counting game channel and restarts the count from 1 (Admin/Owner only).",
            default_member_permissions:
                PermissionFlagsBits.Administrator.toString(),
        },

        // Embed Builder Command
        {
            name: "embed",
            description:
                "Starts an interactive conversation to build and send a new embed.",
            default_member_permissions:
                PermissionFlagsBits.Administrator.toString(),
        },

        // /reactionrole Slash Command
        {
            name: "reactionrole",
            description:
                "Sets up a reaction role on a specific message (Admin only).",
            default_member_permissions:
                PermissionFlagsBits.Administrator.toString(),
            options: [
                {
                    name: "message_id",
                    description:
                        "The ID of the message to monitor for reactions.",
                    type: Discord.ApplicationCommandOptionType.String,
                    required: true,
                },
                {
                    name: "emoji",
                    description:
                        "The emoji users must react with (e.g., 👍 or custom emoji ID).",
                    type: Discord.ApplicationCommandOptionType.String,
                    required: true,
                },
                {
                    name: "role",
                    description: "The role to assign/remove.",
                    type: Discord.ApplicationCommandOptionType.Role,
                    required: true,
                },
                {
                    name: "channel",
                    description:
                        "The channel the message is in (defaults to current channel).",
                    type: Discord.ApplicationCommandOptionType.Channel,
                    required: false,
                    channel_types: [Discord.ChannelType.GuildText],
                },
            ],
        },
    ];

    try {
        await client.application.commands.set(commands);
        console.log("Successfully registered slash commands with permissions.");
    } catch (error) {
        console.error("Failed to register commands:", error);
    }
});

// -------------------------------------------------------------
// Interactive Embed Builder Functions
// -------------------------------------------------------------

/**
 * Starts the interactive conversation to build an embed.
 */
async function startEmbedConversation(interaction) {
    const userId = interaction.user.id;
    const channel = interaction.channel;
    const guild = interaction.guild;

    // Check for existing draft
    if (userEmbedDrafts[userId]) {
        return interaction.reply({
            content:
                "❌ You already have an active embed draft! Please finish or cancel it first.",
            ephemeral: true,
        });
    }

    // Initialize draft
    userEmbedDrafts[userId] = {
        title: "",
        description: "",
        footer: "",
        color: COLOR_MAP.DEFAULT,
        targetChannelId: null,
        status: "awaiting_title",
    };

    // Acknowledge the command and start the prompt
    await interaction.reply({
        content: "✍️ **Embed Builder Started!** Please check the next message.",
        ephemeral: true,
    });

    // Send the first public prompt
    await channel.send(
        `Hey ${interaction.user}, please type the **TITLE** you want for your embed. (Max 256 chars)`,
    );

    // Set a timeout to clean up the draft if the user doesn't respond
    const timeout = setTimeout(() => {
        if (userEmbedDrafts[userId]) {
            channel.send(
                `⏳ ${interaction.user} Embed draft cancelled due to 5-minute inactivity.`,
            );
            delete userEmbedDrafts[userId];
        }
    }, 300000); // 5 minutes

    // Wait for the user's input messages
    const collector = channel.createMessageCollector({
        filter: (m) => m.author.id === userId,
        time: 300000, // 5 minutes
    });

    collector.on("collect", async (m) => {
        clearTimeout(timeout); // Reset timeout on message collect

        const draft = userEmbedDrafts[userId];
        if (!draft) {
            collector.stop();
            return;
        }

        const input = m.content.trim();

        // Command to cancel the draft mid-conversation
        if (input.toLowerCase() === "cancel") {
            delete userEmbedDrafts[userId];
            collector.stop();
            // Delete the user's input message and send confirmation
            m.delete().catch(console.error);
            return channel.send(`🗑️ Embed draft successfully cancelled.`);
        }

        let shouldDeleteInput = true; // Flag to delete user input message

        // --- Handle Input Based on Current Status ---
        switch (draft.status) {
            case "awaiting_title":
                if (input.length > 256) {
                    shouldDeleteInput = false;
                    return channel.send(
                        "❌ Title is too long! Please keep it under 256 characters.",
                    );
                }
                draft.title = input;
                draft.status = "awaiting_description";
                return channel.send(
                    `✅ Title set to: **${input}**.\n\nNext, please type the **DESCRIPTION**. (Supports live mentions and basic formatting like \`\\n\` for new lines).`,
                );

            case "awaiting_description":
                if (input.length > 4096) {
                    shouldDeleteInput = false;
                    return channel.send(
                        "❌ Description is too long! Please keep it under 4096 characters.",
                    );
                }
                draft.description = input;
                draft.status = "awaiting_footer";
                return channel.send(
                    `✅ Description set.\n\nNext, please type the **FOOTER** text. (Optional - type "skip" if you don't want a footer). (Max 2048 chars)`,
                );

            case "awaiting_footer":
                if (input.toLowerCase() === "skip") {
                    draft.footer = null;
                } else {
                    if (input.length > 2048) {
                        shouldDeleteInput = false;
                        return channel.send(
                            "❌ Footer is too long! Please keep it under 2048 characters.",
                        );
                    }
                    draft.footer = input;
                }
                draft.status = "awaiting_color";
                return channel.send(
                    `✅ Footer set.\n\nFinally, please provide the **COLOR** for the sidebar. (Example: \`RED\`, \`BLUE\`, or hex code like \`0xFF0000\`)`,
                );

            case "awaiting_color":
                let newColor =
                    COLOR_MAP[input.toUpperCase()] ||
                    (input.toUpperCase().startsWith("0X") && parseInt(input)) ||
                    null;

                if (!newColor || isNaN(newColor)) {
                    shouldDeleteInput = false;
                    return channel.send(
                        "❌ Invalid color. Please use a valid color name (RED, BLUE) or a hex code (e.g., 0xFF0000).",
                    );
                }

                draft.color = newColor;
                draft.status = "awaiting_channel";

                return channel.send(
                    `✅ Color set.\n\nNext, please **MENTION THE CHANNEL** where you want the embed sent (e.g., \`#announcements\`).`,
                );

            case "awaiting_channel":
                const mentionedChannel = m.mentions.channels.first();

                if (!mentionedChannel) {
                    shouldDeleteInput = false;
                    return channel.send(
                        "❌ Please mention a valid channel (e.g., `#general`).",
                    );
                }

                if (mentionedChannel.type !== Discord.ChannelType.GuildText) {
                    shouldDeleteInput = false;
                    return channel.send(
                        "❌ The target must be a text channel.",
                    );
                }

                // Check if bot can send messages/embeds in the target channel
                const permissions = mentionedChannel.permissionsFor(
                    guild.members.me,
                );
                if (
                    !permissions ||
                    !permissions.has(PermissionFlagsBits.SendMessages) ||
                    !permissions.has(PermissionFlagsBits.EmbedLinks)
                ) {
                    shouldDeleteInput = false;
                    return channel.send(
                        `❌ I do not have permission to send messages and/or embeds in ${mentionedChannel}. Please check my permissions.`,
                    );
                }

                draft.targetChannelId = mentionedChannel.id;
                draft.status = "awaiting_send";

                // Final Preview
                const finalEmbed = new Discord.EmbedBuilder()
                    .setColor(draft.color)
                    .setTitle(draft.title)
                    .setDescription(draft.description)
                    .setTimestamp();

                if (draft.footer) {
                    finalEmbed.setFooter({ text: draft.footer });
                }

                channel.send({
                    content: `🎉 **Embed Complete!** It will be sent to ${mentionedChannel}. Here is the preview:`,
                    embeds: [finalEmbed],
                });
                return channel.send(
                    `\nLast step: Type \`send\` to finalize and send the embed, or type \`cancel\` to discard it.`,
                );

            case "awaiting_send":
                if (input.toLowerCase() === "send") {
                    const targetChannel = guild.channels.cache.get(
                        draft.targetChannelId,
                    );
                    if (!targetChannel) {
                        delete userEmbedDrafts[userId];
                        collector.stop();
                        return channel.send(
                            `❌ Could not find the target channel. Draft cleared.`,
                        );
                    }

                    // Create and Send Final Embed
                    const finalEmbedToSend = new Discord.EmbedBuilder()
                        .setColor(draft.color)
                        .setTitle(draft.title)
                        .setDescription(draft.description)
                        .setTimestamp();

                    if (draft.footer) {
                        finalEmbedToSend.setFooter({ text: draft.footer });
                    }

                    try {
                        await targetChannel.send({
                            embeds: [finalEmbedToSend],
                        });
                        channel.send(
                            `🥳 **Success!** Your embed has been sent to ${targetChannel}. Draft cleared.`,
                        );
                    } catch (e) {
                        channel.send(
                            `❌ Failed to send embed to ${targetChannel}. Check my permissions (Send Messages, Embed Links).`,
                        );
                        console.error("Embed send error:", e);
                    }

                    delete userEmbedDrafts[userId];
                    collector.stop();
                } else {
                    shouldDeleteInput = false;
                    return channel.send(
                        `Unrecognized command. Type \`send\` to send or \`cancel\` to discard.`,
                    );
                }
                break;
        }

        // Clean up the user's input message if successful
        if (shouldDeleteInput) {
            m.delete().catch(console.error);
        }
    });

    collector.on("end", (collected) => {
        clearTimeout(timeout);
        if (
            userEmbedDrafts[userId] &&
            userEmbedDrafts[userId].status !== "awaiting_send"
        ) {
            // If the collector ended without the user reaching the final send/cancel step
            channel.send(`⏳ Embed draft cancelled due to inactivity.`);
            delete userEmbedDrafts[userId];
        }
    });
}

// -------------------------------------------------------------
// Handle Slash Command Interactions
// -------------------------------------------------------------
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isCommand()) return;

    // --- /embed Handler ---
    if (interaction.commandName === "embed") {
        if (
            !interaction.member.permissions.has(
                PermissionFlagsBits.Administrator,
            )
        ) {
            return interaction.reply({
                content:
                    "❌ You need Administrator permissions to use the embed builder.",
                ephemeral: true,
            });
        }
        return startEmbedConversation(interaction);
    }

    // --- /reactionrole Handler ---
    else if (interaction.commandName === "reactionrole") {
        if (
            !interaction.member.permissions.has(
                PermissionFlagsBits.Administrator,
            )
        ) {
            return interaction.reply({
                content:
                    "❌ You need Administrator permissions to set up reaction roles.",
                ephemeral: true,
            });
        }

        const messageId = interaction.options.getString("message_id");
        const emojiInput = interaction.options.getString("emoji");
        const role = interaction.options.getRole("role");
        const channel =
            interaction.options.getChannel("channel") || interaction.channel;

        if (channel.type !== Discord.ChannelType.GuildText) {
            return interaction.reply({
                content: "❌ The target channel must be a text channel.",
                ephemeral: true,
            });
        }

        let emojiName;
        // Handle custom emoji format (<:name:id>)
        const customEmojiMatch = emojiInput.match(/<a?:\w+:(\d+)>/);
        if (customEmojiMatch) {
            emojiName = customEmojiMatch[1]; // Use ID for custom emojis
        } else {
            emojiName = emojiInput; // Use literal emoji for standard emojis
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            const targetMessage = await channel.messages.fetch(messageId);

            // Try to react to the message with the emoji
            await targetMessage.react(emojiName).catch((e) => {
                if (e.code === 10014) {
                    throw new Error(
                        `Invalid emoji provided: ${emojiInput}. Ensure it is a valid server emoji or standard Unicode emoji.`,
                    );
                }
                throw e; // Throw other errors
            });

            // Save to database
            await db.query(
                `INSERT INTO reaction_roles (guild_id, message_id, channel_id, emoji_name, role_id)
                 VALUES ($1, $2, $3, $4, $5) ON CONFLICT (message_id, emoji_name) 
                 DO UPDATE SET role_id = $5;`,
                [
                    interaction.guild.id,
                    messageId,
                    channel.id,
                    emojiName,
                    role.id,
                ],
            );

            interaction.editReply({
                content: `✅ Reaction role set! Reacting to the message in ${channel} with ${emojiInput} will now grant the ${role} role.`,
                ephemeral: true,
            });
        } catch (error) {
            console.error("Error setting reaction role:", error);
            let errorMessage =
                "❌ An unknown error occurred while setting the reaction role.";

            if (error.code === 10008) {
                errorMessage = `❌ Could not find a message with ID \`${messageId}\` in ${channel}. Check the ID and channel!`;
            } else if (error.message.includes("Invalid emoji")) {
                errorMessage = error.message;
            } else {
                errorMessage = `❌ An error occurred: ${error.message}. Check bot permissions (Read History, Add Reactions, Manage Roles).`;
            }

            interaction.editReply({ content: errorMessage, ephemeral: true });
        }
    }

    // --- Counting Game Handlers ---
    else if (
        interaction.commandName === "countinggame" ||
        interaction.commandName === "resetcounting"
    ) {
        if (interaction.commandName === "countinggame") {
            const channel = interaction.options.getChannel("channel");

            if (!channel || channel.type !== Discord.ChannelType.GuildText) {
                return interaction.reply({
                    content: "Please select a valid text channel!",
                    ephemeral: true,
                });
            }

            countingChannelId = channel.id;
            nextNumber = 1;
            await saveState(countingChannelId, nextNumber);

            await interaction.reply({
                content: `Counting Game has been successfully set up in ${channel}!`,
            });

            channel.send(
                `**Counting Game Created!** Start counting from **1**!`,
            );
        } else if (interaction.commandName === "resetcounting") {
            if (
                !interaction.member.permissions.has(
                    PermissionFlagsBits.Administrator,
                )
            ) {
                return interaction.reply({
                    content: "You do not have permission to use this command.",
                    ephemeral: true,
                });
            }

            if (!countingChannelId) {
                return interaction.reply({
                    content:
                        "The counting game has not been set up yet! Use /countinggame first.",
                    ephemeral: true,
                });
            }

            const countingChannel =
                await client.channels.fetch(countingChannelId);

            if (countingChannel) {
                await countingChannel.messages
                    .fetch({ limit: 100 })
                    .then((messages) => countingChannel.bulkDelete(messages));
            }

            nextNumber = 1;
            await saveState(countingChannelId, nextNumber);

            await interaction.reply({
                content: `The Counting Game in ${countingChannel} has been **reset**! Start counting from **1**!`,
            });

            countingChannel.send(
                `**Counting Game Reset!** Start counting from **1**!`,
            );
        }
    }
});

// -------------------------------------------------------------
// Discord Event Listeners
// -------------------------------------------------------------

// --- Reaction Role Cleanup on Message Delete ---
client.on("messageDelete", async (message) => {
    if (message.partial) return;

    try {
        const result = await db.query(
            "DELETE FROM reaction_roles WHERE message_id = $1 AND guild_id = $2 RETURNING *",
            [message.id, message.guild.id],
        );

        if (result.rowCount > 0) {
            console.log(
                `[DB CLEANUP] Removed ${result.rowCount} reaction role entries associated with deleted message ID: ${message.id}`,
            );
        }
    } catch (error) {
        console.error("Error during reaction role cleanup:", error);
    }
});
// ----------------------------------------------------

async function handleReactionRole(reaction, user, added) {
    if (user.bot) return;

    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (error) {
            console.error(
                "Something went wrong when fetching the message:",
                error,
            );
            return;
        }
    }

    const messageId = reaction.message.id;
    const guildId = reaction.message.guild.id;
    let emojiName = reaction.emoji.id ? reaction.emoji.id : reaction.emoji.name;

    try {
        const result = await db.query(
            "SELECT role_id FROM reaction_roles WHERE message_id = $1 AND emoji_name = $2 AND guild_id = $3",
            [messageId, emojiName, guildId],
        );

        if (result.rows.length === 0) return;

        const roleId = result.rows[0].role_id;
        const guild = reaction.message.guild;
        const member = await guild.members.fetch(user.id);
        const role = guild.roles.cache.get(roleId);

        if (!role) {
            console.error(`Role ID ${roleId} not found.`);
            return;
        }

        if (added) {
            await member.roles.add(role).catch(console.error);
        } else {
            await member.roles.remove(role).catch(console.error);
        }
    } catch (error) {
        console.error("Error handling reaction role:", error);
    }
}

client.on("messageReactionAdd", (reaction, user) =>
    handleReactionRole(reaction, user, true),
);
client.on("messageReactionRemove", (reaction, user) =>
    handleReactionRole(reaction, user, false),
);


// Final call to start the whole process
initializeBot();