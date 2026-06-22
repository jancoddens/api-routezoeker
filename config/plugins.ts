import type { Core } from '@strapi/strapi';

const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Plugin => ({
  email: {
    config: {
      provider: 'nodemailer',
      providerOptions: {
        host: env('SMTP_HOST'),
        port: env.int('SMTP_PORT', 465),
        secure: env.bool('SMTP_SECURE', true),
        auth: {
          user: env('SMTP_USER'),
          pass: env('SMTP_PASSWORD'),
        },
        tls: {
          rejectUnauthorized: false,
        },
      },
      settings: {
        defaultFrom: env('SMTP_FROM', env('SMTP_USER', 'info@routezoeker.com')),
        defaultReplyTo: env('SMTP_REPLY_TO', 'info@routezoeker.com'),
      },
    },
  },
  upload: {
    config: {
      provider: 'local',
      providerOptions: {},
      actionOptions: {
        upload: {},
        uploadStream: {},
        delete: {},
      },
    },
  },
});

export default config;
