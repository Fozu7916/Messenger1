using Microsoft.EntityFrameworkCore;
using Messenger.Domain.Entities;
using Messenger.Infrastructure.Persistence;

namespace Messenger.IntegrationTests;

public sealed class DatabaseTests
{
    [Fact]
    public async Task Can_Save_And_Read_Message()
    {
        var options = new DbContextOptionsBuilder<MessengerDbContext>()
            .UseNpgsql(
                "Host=localhost;Port=5432;Database=messenger;Username=messenger;Password=messenger_dev_password")
            .Options;

        await using var db = new MessengerDbContext(options);

        var user = new User("test-user");

        var conversation = new Conversation();

        var member = new ConversationMember(
            conversation.Id,
            user.Id);

        var message = new Message(
            conversation.Id,
            user.Id,
            "Hello from integration test!");

        db.Users.Add(user);
        db.Conversations.Add(conversation);
        db.ConversationMembers.Add(member);
        db.Messages.Add(message);

        await db.SaveChangesAsync();

        var savedMessage = await db.Messages
            .AsNoTracking()
            .SingleAsync(x => x.Id == message.Id);

        Assert.Equal("Hello from integration test!", savedMessage.Content);
        Assert.Equal(user.Id, savedMessage.SenderId);
        Assert.Equal(conversation.Id, savedMessage.ConversationId);
    }
}