using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Messenger.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddPerformanceIndexes : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_message_reactions_dialog_id",
                table: "message_reactions");

            migrationBuilder.CreateIndex(
                name: "ix_refresh_tokens_expires_at",
                table: "refresh_tokens",
                column: "expires_at");

            migrationBuilder.CreateIndex(
                name: "ix_message_reactions_dialog_id_created_at",
                table: "message_reactions",
                columns: new[] { "dialog_id", "created_at" });

            migrationBuilder.CreateIndex(
                name: "ix_email_tokens_expires_at",
                table: "email_tokens",
                column: "expires_at");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_refresh_tokens_expires_at",
                table: "refresh_tokens");

            migrationBuilder.DropIndex(
                name: "ix_message_reactions_dialog_id_created_at",
                table: "message_reactions");

            migrationBuilder.DropIndex(
                name: "ix_email_tokens_expires_at",
                table: "email_tokens");

            migrationBuilder.CreateIndex(
                name: "ix_message_reactions_dialog_id",
                table: "message_reactions",
                column: "dialog_id");
        }
    }
}
