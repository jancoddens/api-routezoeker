import type { Schema, Struct } from '@strapi/strapi';

export interface GeneralSeo extends Struct.ComponentSchema {
  collectionName: 'components_general_seos';
  info: {
    displayName: 'seo';
    icon: 'check';
  };
  attributes: {
    canonical: Schema.Attribute.String;
    meta_description: Schema.Attribute.Text;
    meta_title: Schema.Attribute.Text;
    robots: Schema.Attribute.Enumeration<
      [
        'index, follow',
        'noindex, nofollow',
        'index, nofollow',
        'noindex, follow',
      ]
    >;
  };
}

declare module '@strapi/strapi' {
  export module Public {
    export interface ComponentSchemas {
      'general.seo': GeneralSeo;
    }
  }
}
