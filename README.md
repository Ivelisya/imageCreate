# Private Image Studio

Single-user private image generation site powered by DragonCode `gpt-image-2`.

## Setup

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Generate a password hash:

   ```powershell
   npm run hash-password
   ```

3. Create `.env.local` from `.env.example` and fill:

   ```env
   DRAGON_API_KEY=your_dragoncode_key
   APP_USERNAME=admin
   APP_PASSWORD_HASH=the_bcrypt_hash_from_step_2
   SESSION_SECRET=replace_with_at_least_32_random_characters
   DATABASE_PATH=./data/private-image-studio.json
   ```

4. Start the app:

   ```powershell
   npm run dev
   ```

Open `http://localhost:3000`.

## Notes

- The DragonCode API key is only used by server routes.
- Reference images are converted to base64 data URIs for the first MVP.
- `4k` only supports `16:9`, `9:16`, `2:1`, `1:2`, `21:9`, and `9:21`.
