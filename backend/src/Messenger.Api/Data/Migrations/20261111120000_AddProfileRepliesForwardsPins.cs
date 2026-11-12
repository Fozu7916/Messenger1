using System;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Messenger.Api.Data.Migrations
{
    /// <inheritdoc />
    [DbContext(typeof(AppDbContext))]
    [Migration("20261111120000_AddProfileRepliesForwardsPins")]
    public partial class AddProfileRepliesForwardsPins : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "bio",
                table: "users",
                type: "character varying(300)",
                maxLength: 300,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "forwarded_from_id",
                table: "messages",
                type: "character varying(26)",
                maxLength: 26,
                nullable: true,
                collation: "C");

            migrationBuilder.AddColumn<string>(
                name: "forwarded_from_name",
                table: "messages",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "reply_to_id",
                table: "messages",
                type: "character varying(26)",
                maxLength: 26,
                nullable: true,
                collation: "C");

            migrationBuilder.CreateTable(
                name: "pinned_messages",
                columns: table => new
                {
                    dialog_id = table.Column<string>(type: "character varying(26)", maxLength: 26, nullable: false, collation: "C"),
                    message_id = table.Column<string>(type: "character varying(26)", maxLength: 26, nullable: false, collation: "C"),
                    pinned_by_id = table.Column<string>(type: "character varying(26)", maxLength: 26, nullable: false, collation: "C"),
                    pinned_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false, defaultValueSql: "now()")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_pinned_messages", x => new { x.dialog_id, x.message_id });
                    table.ForeignKey(
                        name: "fk_pinned_messages_dialogs_dialog_id",
                        column: x => x.dialog_id,
                        principalTable: "dialogs",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_pinned_messages_messages_message_id",
                        column: x => x.message_id,
                        principalTable: "messages",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_messages_reply_to_id",
                table: "messages",
                column: "reply_to_id");

            migrationBuilder.CreateIndex(
                name: "ix_pinned_messages_dialog_id_pinned_at",
                table: "pinned_messages",
                columns: new[] { "dialog_id", "pinned_at" });

            migrationBuilder.CreateIndex(
                name: "ix_pinned_messages_message_id",
                table: "pinned_messages",
                column: "message_id");

            migrationBuilder.AddForeignKey(
                name: "fk_messages_messages_reply_to_id",
                table: "messages",
                column: "reply_to_id",
                principalTable: "messages",
                principalColumn: "id",
                onDelete: ReferentialAction.SetNull);

            // Поиск «по частям» (ILIKE '%слово%') без триграммных индексов — полный перебор таблицы.
            migrationBuilder.Sql("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
            migrationBuilder.Sql("CREATE INDEX ix_messages_text_trgm ON messages USING gin (text gin_trgm_ops) WHERE deleted_at IS NULL;");
            migrationBuilder.Sql("CREATE INDEX ix_users_login_trgm ON users USING gin (login gin_trgm_ops);");
            migrationBuilder.Sql("CREATE INDEX ix_users_display_name_trgm ON users USING gin (display_name gin_trgm_ops);");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("DROP INDEX IF EXISTS ix_users_display_name_trgm;");
            migrationBuilder.Sql("DROP INDEX IF EXISTS ix_users_login_trgm;");
            migrationBuilder.Sql("DROP INDEX IF EXISTS ix_messages_text_trgm;");

            migrationBuilder.DropForeignKey(name: "fk_messages_messages_reply_to_id", table: "messages");
            migrationBuilder.DropTable(name: "pinned_messages");
            migrationBuilder.DropIndex(name: "ix_messages_reply_to_id", table: "messages");
            migrationBuilder.DropColumn(name: "reply_to_id", table: "messages");
            migrationBuilder.DropColumn(name: "forwarded_from_name", table: "messages");
            migrationBuilder.DropColumn(name: "forwarded_from_id", table: "messages");
            migrationBuilder.DropColumn(name: "bio", table: "users");
        }
    }
}
