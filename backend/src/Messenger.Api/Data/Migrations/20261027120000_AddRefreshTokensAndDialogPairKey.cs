using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Messenger.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddRefreshTokensAndDialogPairKey : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "pair_key",
                table: "dialogs",
                type: "character varying(64)",
                maxLength: 64,
                nullable: true);

            // Ключ пары для существующих диалогов; при дублях ключ остаётся только у самого раннего диалога.
            migrationBuilder.Sql(@"
UPDATE dialogs d SET pair_key = k.pk
FROM (SELECT dialog_id, string_agg(user_id, ':' ORDER BY user_id) AS pk, count(*) AS c FROM dialog_members GROUP BY dialog_id) k
WHERE k.dialog_id = d.id AND k.c = 2;
UPDATE dialogs d SET pair_key = NULL
FROM (SELECT id, row_number() OVER (PARTITION BY pair_key ORDER BY created_at, id) AS rn FROM dialogs WHERE pair_key IS NOT NULL) r
WHERE r.id = d.id AND r.rn > 1;");

            migrationBuilder.CreateIndex(
                name: "ix_dialogs_pair_key",
                table: "dialogs",
                column: "pair_key",
                unique: true);

            migrationBuilder.CreateTable(
                name: "refresh_tokens",
                columns: table => new
                {
                    id = table.Column<string>(type: "character varying(26)", maxLength: 26, nullable: false, collation: "C"),
                    user_id = table.Column<string>(type: "character varying(26)", maxLength: 26, nullable: false, collation: "C"),
                    token_hash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    expires_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    revoked_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    replaced_by_id = table.Column<string>(type: "character varying(26)", maxLength: 26, nullable: true, collation: "C")
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_refresh_tokens", x => x.id);
                    table.ForeignKey(
                        name: "fk_refresh_tokens_users_user_id",
                        column: x => x.user_id,
                        principalTable: "users",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(name: "ix_refresh_tokens_token_hash", table: "refresh_tokens", column: "token_hash", unique: true);
            migrationBuilder.CreateIndex(name: "ix_refresh_tokens_user_id", table: "refresh_tokens", column: "user_id");

            // Чистим старые небезопасные аватарки (http, логин в URL, localhost и приватные адреса).
            migrationBuilder.Sql(@"
UPDATE users SET avatar_url = NULL
WHERE avatar_url IS NOT NULL
  AND (avatar_url !~* '^https://'
       OR avatar_url ~* '^https://([^/]*@|localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|\[)');");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "refresh_tokens");
            migrationBuilder.DropIndex(name: "ix_dialogs_pair_key", table: "dialogs");
            migrationBuilder.DropColumn(name: "pair_key", table: "dialogs");
        }
    }
}
